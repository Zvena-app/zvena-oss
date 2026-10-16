use skia_safe::{self as skia, Paint, RRect};

use super::{filters, RenderState, SurfaceId};
use crate::error::Result;
use crate::get_resources;
use crate::render::{get_fit_dest_rect, get_source_rect};
use crate::shapes::{merge_fills, Fill, Frame, ImageCrop, ImageFill, ImageScaleMode, Rect, Shape, Type};

// Set the clipping area to the shape outline within the container bounds
fn clip_to_shape(
    canvas: &skia::Canvas,
    shape: &Shape,
    container: &crate::math::Rect,
    antialias: bool,
) {
    // zvena: smoothed corners clip with the squircle outline
    if let Some(path) = shape.smooth_corners_path(container) {
        canvas.clip_path(&path, skia::ClipOp::Intersect, antialias);
        return;
    }

    match &shape.shape_type {
        Type::Rect(Rect {
            corners: Some(corners),
        })
        | Type::Frame(Frame {
            corners: Some(corners),
            ..
        }) => {
            let rrect: RRect = RRect::new_rect_radii(container, corners);
            canvas.clip_rrect(rrect, skia::ClipOp::Intersect, antialias);
        }
        Type::Rect(_) | Type::Frame(_) => {
            canvas.clip_rect(container, skia::ClipOp::Intersect, antialias);
        }
        Type::Circle => {
            let oval_path = {
                let mut pb = skia::PathBuilder::new();
                pb.add_oval(container, None, None);
                pb.detach()
            };
            canvas.clip_path(&oval_path, skia::ClipOp::Intersect, antialias);
        }
        shape_type @ (Type::Path(_) | Type::Bool(_)) => {
            if let Some(path) = shape_type.path() {
                if let Some(path_transform) = shape.to_path_transform() {
                    canvas.clip_path(
                        &path
                            .to_skia_path(shape.svg_attrs.as_ref())
                            .make_transform(&path_transform),
                        skia::ClipOp::Intersect,
                        antialias,
                    );
                }
            }
        }
        Type::SVGRaw(_) => {
            canvas.clip_rect(container, skia::ClipOp::Intersect, antialias);
        }
        Type::Group(_) => unreachable!("A group should not have fills"),
        Type::Text(_) => unimplemented!("TODO"),
    }
}

/// zvena: the fill paint with the image's color adjustments applied.
fn adjusted_paint(paint: &Paint, image_fill: &ImageFill) -> Paint {
    let adjust = image_fill.adjust();
    let mut out = paint.clone();
    if adjust.is_identity() {
        return out;
    }
    let matrix = skia::color_filters::matrix_row_major(&adjust.matrix(), None);
    let filter = match adjust.table().and_then(|t| skia::color_filters::table(&t)) {
        Some(table) => table.composed(matrix.clone()).unwrap_or(matrix),
        None => matrix,
    };
    out.set_color_filter(filter);
    out
}

fn draw_image_fill(
    render_state: &mut RenderState,
    shape: &Shape,
    image_fill: &ImageFill,
    paint: &Paint,
    antialias: bool,
    surface_id: SurfaceId,
) {
    if draw_svg_image_fill(
        render_state,
        shape,
        image_fill,
        paint,
        antialias,
        surface_id,
    ) {
        return;
    }

    let Some(image) = get_resources().images.get(&image_fill.id()) else {
        return;
    };

    let size = image.dimensions();
    let canvas = render_state.surfaces.canvas_and_mark_dirty(surface_id);
    let container = &shape.selrect;

    // zvena: color adjustments as a color filter on the fill paint
    let adjusted = adjusted_paint(paint, image_fill);
    let paint = &adjusted;

    let mut image_paint = skia::Paint::default();
    image_paint.set_anti_alias(antialias);
    if let Some(filter) = shape.image_filter(1.) {
        image_paint.set_image_filter(filter.clone());
    }

    let layer_rec = skia::canvas::SaveLayerRec::default().paint(&image_paint);
    // Save the current canvas state
    canvas.save_layer(&layer_rec);

    clip_to_shape(canvas, shape, container, antialias);

    // zvena: the image rotates in quarter turns around the shape's center;
    // for 90/270 it fits the swapped box.
    let rotation = image_fill.rotation();
    let quarter = rotation == 90 || rotation == 270;
    let center = container.center();
    let frame = if quarter {
        crate::math::Rect::from_xywh(
            center.x - container.height() / 2.0,
            center.y - container.width() / 2.0,
            container.height(),
            container.width(),
        )
    } else {
        *container
    };
    let mode = image_fill.scale_mode();
    if rotation != 0 && mode != ImageScaleMode::Crop {
        canvas.save();
        canvas.rotate(rotation as f32, Some(center));
    }

    if mode == ImageScaleMode::Tile && size.width > 0 && size.height > 0 {
        // zvena: Tile — the image at its natural size (the fill's width and
        // height) times the tile scale, repeated from the shape's corner.
        let natural_w = if image_fill.width() > 0 { image_fill.width() as f32 } else { size.width as f32 };
        let natural_h = if image_fill.height() > 0 { image_fill.height() as f32 } else { size.height as f32 };
        let sx = natural_w * image_fill.tile_factor() / size.width as f32;
        let sy = natural_h * image_fill.tile_factor() / size.height as f32;
        let mut matrix = skia::Matrix::translate((frame.left, frame.top));
        matrix.pre_scale((sx, sy), None);
        if let Some(shader) = image.to_shader(
            Some((skia::TileMode::Repeat, skia::TileMode::Repeat)),
            get_resources().sampling_options,
            Some(&matrix),
        ) {
            let mut tile_paint = paint.clone();
            tile_paint.set_shader(shader);
            canvas.draw_rect(frame, &tile_paint);
        }
    } else if mode == ImageScaleMode::Crop && size.width > 0 && size.height > 0 {
        // zvena: Crop — covers the shape, zoomed and placed by x/y (0..1),
        // rotated around the image's own center (same math as the SVG view).
        let crop = image_fill.crop().unwrap_or(ImageCrop { zoom: 1.0, x: 0.5, y: 0.5 });
        let (iw, ih) = (size.width as f32, size.height as f32);
        let (rw, rh) = if quarter { (ih, iw) } else { (iw, ih) };
        let sc = crop.zoom * (container.width() / rw).max(container.height() / rh);
        let (dw, dh) = (rw * sc, rh * sc);
        let cx = container.left + (container.width() - dw) * crop.x + dw / 2.0;
        let cy = container.top + (container.height() - dh) * crop.y + dh / 2.0;
        let (w, h) = (iw * sc, ih * sc);
        if rotation != 0 {
            canvas.save();
            canvas.rotate(rotation as f32, Some(skia::Point::new(cx, cy)));
        }
        canvas.draw_image_rect_with_sampling_options(
            image,
            None,
            crate::math::Rect::from_xywh(cx - w / 2.0, cy - h / 2.0, w, h),
            get_resources().sampling_options,
            paint,
        );
        if rotation != 0 {
            canvas.restore();
        }
    } else {
        let src_rect = get_source_rect(size, &frame, image_fill);
        // zvena: Fit letterboxes the whole image; the other modes use the box.
        let dest_rect = get_fit_dest_rect(size, &frame, image_fill);
        canvas.draw_image_rect_with_sampling_options(
            image,
            Some((&src_rect, skia::canvas::SrcRectConstraint::Strict)),
            dest_rect,
            get_resources().sampling_options,
            paint,
        );
    }

    if rotation != 0 && mode != ImageScaleMode::Crop {
        canvas.restore();
    }

    // Restore the canvas to remove the clipping
    canvas.restore();
}

// Draws an SVG image fill from its parsed DOM. The canvas transform carries
// the current zoom, so the SVG rasterizes at display resolution instead of
// being stretched from a fixed-size texture. Returns false when the stored
// image is not an SVG.
fn draw_svg_image_fill(
    render_state: &mut RenderState,
    shape: &Shape,
    image_fill: &ImageFill,
    paint: &Paint,
    antialias: bool,
    surface_id: SurfaceId,
) -> bool {
    let Some((dom, size)) = get_resources().images.get_svg(&image_fill.id()) else {
        return false;
    };

    let canvas = render_state.surfaces.canvas_and_mark_dirty(surface_id);
    let container = &shape.selrect;
    let size = skia::ISize::new(size.width as i32, size.height as i32);
    let src_rect = get_source_rect(size, container, image_fill);
    if src_rect.width() <= 0.0 || src_rect.height() <= 0.0 {
        return true;
    }

    let mut image_paint = skia::Paint::default();
    image_paint.set_anti_alias(antialias);
    if let Some(filter) = shape.image_filter(1.) {
        image_paint.set_image_filter(filter.clone());
    }

    let layer_rec = skia::canvas::SaveLayerRec::default().paint(&image_paint);
    canvas.save_layer(&layer_rec);

    clip_to_shape(canvas, shape, container, antialias);

    // Apply the fill paint (opacity/blend) to the whole SVG as one layer.
    let fill_layer = skia::canvas::SaveLayerRec::default().paint(paint);
    canvas.save_layer(&fill_layer);

    // Map the cropped source rect onto the container: cover semantics when
    // keep-aspect-ratio is set, stretch otherwise (same math as the raster
    // path, expressed as a canvas transform).
    let dest = get_fit_dest_rect(size, container, image_fill);
    let scale_x = dest.width() / src_rect.width();
    let scale_y = dest.height() / src_rect.height();
    canvas.translate((
        dest.left - src_rect.left * scale_x,
        dest.top - src_rect.top * scale_y,
    ));
    canvas.scale((scale_x, scale_y));
    dom.render(canvas);

    canvas.restore();
    canvas.restore();

    true
}

/**
 * This SHOULD be the only public function in this module.
 */
pub fn render(
    render_state: &mut RenderState,
    shape: &Shape,
    fills: &[Fill],
    antialias: bool,
    surface_id: SurfaceId,
    outset: Option<f32>,
) -> Result<()> {
    if fills.is_empty() {
        return Ok(());
    }

    let scale = render_state.get_scale().max(1e-6);
    let inset = if shape.has_inner_stroke() {
        Some(1.0 / scale)
    } else {
        None
    };

    // Image fills use draw_image_fill which needs render_state for GPU images
    // and sampling options that get_fill_shader (used by merge_fills) lacks.
    let has_image_fills = fills.iter().any(|f| matches!(f, Fill::Image(_)));
    if has_image_fills {
        for fill in fills.iter().rev() {
            render_single_fill(
                render_state,
                shape,
                fill,
                antialias,
                surface_id,
                outset,
                inset,
            )?;
        }
        return Ok(());
    }

    let mut paint = merge_fills(fills, shape.selrect);
    paint.set_anti_alias(antialias);

    if let Some(image_filter) = shape.image_filter(1.) {
        let bounds = image_filter.compute_fast_bounds(shape.selrect);
        if filters::render_with_filter_surface(
            render_state,
            bounds,
            surface_id,
            |state, temp_surface| {
                let mut filtered_paint = paint.clone();
                filtered_paint.set_image_filter(image_filter.clone());
                draw_fill_to_surface(state, shape, temp_surface, &filtered_paint, outset, inset);
                Ok(())
            },
        )? {
            return Ok(());
        } else {
            paint.set_image_filter(image_filter);
        }
    }

    draw_fill_to_surface(render_state, shape, surface_id, &paint, outset, inset);
    Ok(())
}

/// Draws a single paint (with a merged shader) to the appropriate surface
/// based on the shape type.
/// When `inset` is Some(eps), the fill is inset by eps (e.g. to avoid seam with inner strokes).
fn draw_fill_to_surface(
    render_state: &mut RenderState,
    shape: &Shape,
    surface_id: SurfaceId,
    paint: &Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    match &shape.shape_type {
        Type::Rect(_) | Type::Frame(_) => {
            render_state
                .surfaces
                .draw_rect_to(surface_id, shape, paint, outset, inset);
        }
        Type::Circle => {
            render_state
                .surfaces
                .draw_circle_to(surface_id, shape, paint, outset, inset);
        }
        Type::Path(_) | Type::Bool(_) => {
            render_state
                .surfaces
                .draw_path_to(surface_id, shape, paint, outset, inset);
        }
        Type::Group(_) => {}
        _ => unreachable!("This shape should not have fills"),
    }
}

fn render_single_fill(
    render_state: &mut RenderState,
    shape: &Shape,
    fill: &Fill,
    antialias: bool,
    surface_id: SurfaceId,
    outset: Option<f32>,
    inset: Option<f32>,
) -> Result<()> {
    let mut paint = fill.to_paint(&shape.selrect, antialias);
    if let Some(image_filter) = shape.image_filter(1.) {
        let bounds = image_filter.compute_fast_bounds(shape.selrect);
        if filters::render_with_filter_surface(
            render_state,
            bounds,
            surface_id,
            |state, temp_surface| {
                let mut filtered_paint = paint.clone();
                filtered_paint.set_image_filter(image_filter.clone());
                draw_single_fill_to_surface(
                    state,
                    shape,
                    fill,
                    antialias,
                    temp_surface,
                    &filtered_paint,
                    outset,
                    inset,
                );
                Ok(())
            },
        )? {
            return Ok(());
        } else {
            paint.set_image_filter(image_filter);
        }
    }

    draw_single_fill_to_surface(
        render_state,
        shape,
        fill,
        antialias,
        surface_id,
        &paint,
        outset,
        inset,
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn draw_single_fill_to_surface(
    render_state: &mut RenderState,
    shape: &Shape,
    fill: &Fill,
    antialias: bool,
    surface_id: SurfaceId,
    paint: &Paint,
    outset: Option<f32>,
    inset: Option<f32>,
) {
    match (fill, &shape.shape_type) {
        (Fill::Image(image_fill), _) => {
            draw_image_fill(
                render_state,
                shape,
                image_fill,
                paint,
                antialias,
                surface_id,
            );
        }
        (_, Type::Rect(_) | Type::Frame(_)) => {
            render_state
                .surfaces
                .draw_rect_to(surface_id, shape, paint, outset, inset);
        }
        (_, Type::Circle) => {
            render_state
                .surfaces
                .draw_circle_to(surface_id, shape, paint, outset, inset);
        }
        (_, Type::Path(_)) | (_, Type::Bool(_)) => {
            render_state
                .surfaces
                .draw_path_to(surface_id, shape, paint, outset, inset);
        }
        (_, Type::Group(_)) => {
            // Groups can have fills but they propagate them to their children
        }
        _ => unreachable!("This shape should not have fills"),
    }
}
