use skia_safe::{self as skia, Paint, Rect};

pub use super::Color;
use crate::utils::get_image;
use crate::uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub struct Gradient {
    start: (f32, f32),
    end: (f32, f32),
    opacity: u8,
    width: f32,
    colors: Vec<Color>,
    offsets: Vec<f32>,
    // zvena: 0 radial/linear, 1 angular (conic), 2 diamond
    kind: u8,
}

impl Gradient {
    pub fn new(
        start: (f32, f32),
        end: (f32, f32),
        opacity: u8,
        width: f32,
        stops: &[(Color, f32)],
    ) -> Self {
        let mut gradient = Gradient {
            start,
            end,
            opacity,
            colors: vec![],
            offsets: vec![],
            kind: 0,
            width,
        };

        gradient.add_stops(stops);
        gradient
    }

    fn add_stops(&mut self, stops: &[(Color, f32)]) {
        let colors = stops.iter().map(|(color, _)| *color);
        let offsets = stops.iter().map(|(_, offset)| *offset);
        self.colors.extend(colors);
        self.offsets.extend(offsets);
    }

    pub fn start(&self) -> (f32, f32) {
        self.start
    }

    pub fn end(&self) -> (f32, f32) {
        self.end
    }

    pub fn opacity(&self) -> u8 {
        self.opacity
    }

    pub fn width(&self) -> f32 {
        self.width
    }

    pub fn stops(&self) -> impl Iterator<Item = (Color, f32)> + '_ {
        self.colors
            .iter()
            .copied()
            .zip(self.offsets.iter().copied())
    }

    pub fn to_linear_shader(&self, rect: &Rect) -> Option<skia::Shader> {
        let start = (
            rect.left + self.start.0 * rect.width(),
            rect.top + self.start.1 * rect.height(),
        );
        let end = (
            rect.left + self.end.0 * rect.width(),
            rect.top + self.end.1 * rect.height(),
        );
        skia::gradient_shader::linear(
            (start, end),
            self.colors.as_slice(),
            Some(self.offsets.as_slice()),
            skia::TileMode::Clamp,
            None,
            None,
        )
    }

    pub fn with_kind(mut self, kind: u8) -> Self {
        self.kind = kind;
        self
    }

    pub fn kind(&self) -> u8 {
        self.kind
    }

    /// zvena: Figma's angular gradient — a sweep around `start`, beginning
    /// in the direction of `end`; the shape's aspect stretches it as in the
    /// SVG renderer.
    fn to_sweep_shader(&self, rect: &Rect) -> Option<skia::Shader> {
        let center = skia::Point::new(
            rect.left + self.start.0 * rect.width(),
            rect.top + self.start.1 * rect.height(),
        );
        let end = skia::Point::new(
            rect.left + self.end.0 * rect.width(),
            rect.top + self.end.1 * rect.height(),
        );
        let direction = end - center;
        let angle = direction.y.atan2(direction.x).to_degrees();
        let mut transform = skia::Matrix::new_identity();
        transform.pre_rotate(angle, center);
        skia::gradient_shader::sweep(
            center,
            self.colors.as_slice(),
            Some(self.offsets.as_slice()),
            skia::TileMode::Clamp,
            None,
            None,
            Some(&transform),
        )
    }

    pub fn to_radial_shader(&self, rect: &Rect) -> Option<skia::Shader> {
        // zvena: angular gradients travel as radial ones with a kind;
        // diamond falls back to the radial look in this renderer.
        if self.kind == 1 {
            return self.to_sweep_shader(rect);
        }
        let center = skia::Point::new(
            rect.left + self.start.0 * rect.width(),
            rect.top + self.start.1 * rect.height(),
        );
        let end = skia::Point::new(
            rect.left + self.end.0 * rect.width(),
            rect.top + self.end.1 * rect.height(),
        );

        let direction = end - center;
        let distance = (direction.x.powi(2) + direction.y.powi(2)).sqrt();
        let angle = direction.y.atan2(direction.x).to_degrees();

        // Based on the code from frontend/src/app/main/ui/shapes/gradients.cljs
        let mut transform = skia::Matrix::new_identity();
        transform.pre_translate((center.x, center.y));
        transform.pre_rotate(angle + 90., skia::Point::new(0., 0.));
        // We need an extra transform, because in skia radial gradients are circular and we need them to be ellipses if they must adapt to the shape
        transform.pre_scale((self.width * rect.width() / rect.height(), 1.), None);
        transform.pre_translate((-center.x, -center.y));

        skia::gradient_shader::radial(
            center,
            distance,
            self.colors.as_slice(),
            Some(self.offsets.as_slice()),
            skia::TileMode::Clamp,
            None,
            Some(&transform),
        )
    }
}

/// zvena: Figma's image scale modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageScaleMode {
    /// Cover the shape, cropping the overflow (centered).
    Fill,
    /// Fit inside the shape, letterboxed (centered).
    Fit,
    /// Stretch to the shape, ignoring the aspect ratio.
    Stretch,
    /// Repeat the image at its natural size times `tile_scale` percent.
    Tile,
    /// Cover the shape zoomed by `crop.zoom`, placed by `crop.x/y` (0..1).
    Crop,
}

/// zvena: Figma's image adjustments (-100..100 each) and crop placement.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ImageAdjust {
    pub exposure: i8,
    pub contrast: i8,
    pub saturation: i8,
    pub temperature: i8,
    pub tint: i8,
    pub highlights: i8,
    pub shadows: i8,
}

impl ImageAdjust {
    pub fn is_identity(&self) -> bool {
        *self == ImageAdjust::default()
    }

    /// 4x5 color matrix (offsets in 0..1), same math as
    /// app.common.types.color/image-adjust-matrix.
    pub fn matrix(&self) -> [f32; 20] {
        let v = |x: i8| x as f32 / 100.0;
        let g = 2f32.powf(v(self.exposure));
        let t = v(self.temperature);
        let n = v(self.tint);
        let rg = g * (1.0 + 0.2 * t) * (1.0 + 0.1 * n);
        let gg = g * (1.0 - 0.2 * n);
        let bg = g * (1.0 - 0.2 * t) * (1.0 + 0.1 * n);
        let gain = [rg, 0., 0., 0., 0., 0., gg, 0., 0., 0., 0., 0., bg, 0., 0., 0., 0., 0., 1., 0.];
        let k = 1.0 + v(self.contrast);
        let o = 0.5 * (1.0 - k);
        let contrast = [k, 0., 0., 0., o, 0., k, 0., 0., o, 0., 0., k, 0., o, 0., 0., 0., 1., 0.];
        let s = 1.0 + v(self.saturation);
        let (lr, lg, lb) = (0.2126f32, 0.7152f32, 0.0722f32);
        let sat = [
            lr + (1. - lr) * s, lg * (1. - s), lb * (1. - s), 0., 0.,
            lr * (1. - s), lg + (1. - lg) * s, lb * (1. - s), 0., 0.,
            lr * (1. - s), lg * (1. - s), lb + (1. - lb) * s, 0., 0.,
            0., 0., 0., 1., 0.,
        ];
        mat_mul(&sat, &mat_mul(&contrast, &gain))
    }

    /// The highlights/shadows tone curve as a 256-entry table, if any.
    pub fn table(&self) -> Option<[u8; 256]> {
        if self.highlights == 0 && self.shadows == 0 {
            return None;
        }
        let h = self.highlights as f32 / 100.0;
        let sh = self.shadows as f32 / 100.0;
        let c = |x: f32| x.clamp(0.0, 1.0);
        let pts = [c(0.15 * sh), c(0.25 + 0.1 * sh), 0.5, c(0.75 + 0.1 * h), c(1.0 + 0.15 * h)];
        let mut out = [0u8; 256];
        for (i, slot) in out.iter_mut().enumerate() {
            let x = i as f32 / 255.0 * 4.0;
            let k = (x.floor() as usize).min(3);
            let f = x - k as f32;
            let y = pts[k] + (pts[k + 1] - pts[k]) * f;
            *slot = (y * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        Some(out)
    }
}

fn mat_mul(b: &[f32; 20], a: &[f32; 20]) -> [f32; 20] {
    let mut out = [0f32; 20];
    for r in 0..4 {
        for c in 0..5 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += b[r * 5 + k] * a[k * 5 + c];
            }
            if c == 4 {
                sum += b[r * 5 + 4];
            }
            out[r * 5 + c] = sum;
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageCrop {
    pub zoom: f32,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageFill {
    id: Uuid,
    opacity: u8,
    width: i32,
    height: i32,
    keep_aspect_ratio: bool,
    scale_mode: ImageScaleMode,
    tile_scale: u16,
    rotation: u16,
    adjust: ImageAdjust,
    crop: Option<ImageCrop>,
}

impl ImageFill {
    pub fn new(id: Uuid, opacity: u8, width: i32, height: i32, keep_aspect_ratio: bool) -> Self {
        Self {
            id,
            opacity,
            width,
            height,
            keep_aspect_ratio,
            scale_mode: if keep_aspect_ratio {
                ImageScaleMode::Fill
            } else {
                ImageScaleMode::Stretch
            },
            tile_scale: 100,
            rotation: 0,
            adjust: ImageAdjust::default(),
            crop: None,
        }
    }

    pub fn with_extras(mut self, rotation: u16, adjust: ImageAdjust, crop: Option<ImageCrop>) -> Self {
        self.rotation = rotation % 360;
        self.adjust = adjust;
        self.crop = crop;
        self
    }

    pub fn rotation(&self) -> u16 {
        self.rotation
    }

    pub fn adjust(&self) -> ImageAdjust {
        self.adjust
    }

    pub fn crop(&self) -> Option<ImageCrop> {
        self.crop
    }

    pub fn with_scale_mode(mut self, scale_mode: ImageScaleMode, tile_scale: u16) -> Self {
        self.scale_mode = scale_mode;
        self.tile_scale = tile_scale.clamp(1, 1000);
        self
    }

    pub fn scale_mode(&self) -> ImageScaleMode {
        self.scale_mode
    }

    /// Tile size factor relative to the image's natural size.
    pub fn tile_factor(&self) -> f32 {
        self.tile_scale as f32 / 100.0
    }

    pub fn tile_scale(&self) -> u16 {
        self.tile_scale
    }

    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn opacity(&self) -> u8 {
        self.opacity
    }

    pub fn keep_aspect_ratio(&self) -> bool {
        self.keep_aspect_ratio
    }

    pub fn width(&self) -> i32 {
        self.width
    }

    pub fn height(&self) -> i32 {
        self.height
    }
}

#[derive(Debug, Clone, PartialEq, Copy)]
pub struct SolidColor(pub Color);

#[derive(Debug, Clone, PartialEq)]
pub enum Fill {
    Solid(SolidColor),
    LinearGradient(Gradient),
    RadialGradient(Gradient),
    Image(ImageFill),
}

impl Fill {
    pub fn opacity(&self) -> f32 {
        match self {
            Fill::Solid(SolidColor(color)) => color.a() as f32 / 255.0,
            Fill::LinearGradient(g) => g.opacity as f32 / 255.0,
            Fill::RadialGradient(g) => g.opacity as f32 / 255.0,
            Fill::Image(i) => i.opacity as f32 / 255.0,
        }
    }

    pub fn with_full_opacity(&self) -> Fill {
        match self {
            Fill::Solid(SolidColor(color)) => Fill::Solid(SolidColor(skia::Color::from_argb(
                255,
                color.r(),
                color.g(),
                color.b(),
            ))),
            Fill::LinearGradient(g) => Fill::LinearGradient(Gradient {
                opacity: 255,
                ..g.clone()
            }),
            Fill::RadialGradient(g) => Fill::RadialGradient(Gradient {
                opacity: 255,
                ..g.clone()
            }),
            Fill::Image(i) => Fill::Image(ImageFill {
                opacity: 255,
                ..i.clone()
            }),
        }
    }

    pub fn to_paint(&self, rect: &Rect, anti_alias: bool) -> skia::Paint {
        match self {
            Self::Solid(SolidColor(color)) => {
                let mut p = skia::Paint::default();
                p.set_color(*color);
                p.set_style(skia::PaintStyle::Fill);
                p.set_anti_alias(anti_alias);
                p.set_blend_mode(skia::BlendMode::SrcOver);
                p
            }
            Self::LinearGradient(gradient) => {
                let mut p = skia::Paint::default();
                p.set_shader(gradient.to_linear_shader(rect));
                p.set_alpha(gradient.opacity);
                p.set_style(skia::PaintStyle::Fill);
                p.set_anti_alias(anti_alias);
                p.set_blend_mode(skia::BlendMode::SrcOver);
                p
            }
            Self::RadialGradient(gradient) => {
                let mut p = skia::Paint::default();
                p.set_shader(gradient.to_radial_shader(rect));
                p.set_alpha(gradient.opacity);
                p.set_style(skia::PaintStyle::Fill);
                p.set_anti_alias(anti_alias);
                p.set_blend_mode(skia::BlendMode::SrcOver);
                p
            }
            Self::Image(image_fill) => {
                let mut p = skia::Paint::default();
                p.set_style(skia::PaintStyle::Fill);
                p.set_anti_alias(anti_alias);
                p.set_blend_mode(skia::BlendMode::SrcOver);
                p.set_alpha(image_fill.opacity);
                p
            }
        }
    }
}

pub fn get_fill_shader(fill: &Fill, bounding_box: &Rect) -> Option<skia::Shader> {
    match fill {
        Fill::Solid(SolidColor(color)) => Some(skia::shaders::color(*color)),
        Fill::LinearGradient(gradient) => gradient.to_linear_shader(bounding_box),
        Fill::RadialGradient(gradient) => gradient.to_radial_shader(bounding_box),
        Fill::Image(image_fill) => {
            let mut image_shader = None;
            let image = get_image(&image_fill.id);
            if let Some(image) = image {
                let sampling_options =
                    skia::SamplingOptions::new(skia::FilterMode::Linear, skia::MipmapMode::Nearest);

                // FIXME no image ratio applied, centered to the current rect
                let tile_modes = (skia::TileMode::Clamp, skia::TileMode::Clamp);
                let image_width = image_fill.width as f32;
                let image_height = image_fill.height as f32;
                let scale_x = bounding_box.width() / image_width;
                let scale_y = bounding_box.height() / image_height;
                let scale = scale_x.max(scale_y);
                let scaled_width = image_width * scale;
                let scaled_height = image_height * scale;
                let pos_x = bounding_box.left() - (scaled_width - bounding_box.width()) / 2.0;
                let pos_y = bounding_box.top() - (scaled_height - bounding_box.height()) / 2.0;

                let mut matrix = skia::Matrix::new_identity();
                matrix.pre_translate((pos_x, pos_y));
                matrix.pre_scale((scale, scale), None);

                let opacity = image_fill.opacity();
                let alpha_color = skia::Color4f::new(1.0, 1.0, 1.0, opacity as f32 / 255.0);
                let alpha_shader = skia::shaders::color(alpha_color.to_color());

                image_shader = image.to_shader(tile_modes, sampling_options, &matrix);
                if let Some(shader) = image_shader {
                    image_shader = Some(skia::shaders::blend(
                        skia::Blender::mode(skia::BlendMode::DstIn),
                        shader,
                        alpha_shader,
                    ));
                }
            }
            image_shader
        }
    }
}

pub fn merge_fills(fills: &[Fill], bounding_box: Rect) -> skia::Paint {
    let mut fills_paint = skia::Paint::default();

    if fills.is_empty() {
        fills_paint.set_color(skia::Color::TRANSPARENT);
        return fills_paint;
    }

    if fills.len() == 1 {
        if let Fill::Solid(SolidColor(color)) = &fills[0] {
            fills_paint.set_color(*color);
            return fills_paint;
        }
    }

    let mut combined_shader: Option<skia::Shader> = None;
    for fill in fills {
        let shader = get_fill_shader(fill, &bounding_box);

        if let Some(shader) = shader {
            combined_shader = match combined_shader {
                // Use SrcOver and treat the newly encountered fill as the source (top),
                // overlaying it over the previously composed shader (destination/bottom).
                // This avoids edge bleed from underlying fills when anti-aliasing causes
                // fractional coverage at shape boundaries.
                Some(existing_shader) => Some(skia::shaders::blend(
                    skia::Blender::mode(skia::BlendMode::SrcOver),
                    shader,
                    existing_shader,
                )),
                None => Some(shader),
            };
        }
    }

    fills_paint.set_shader(combined_shader);
    fills_paint
}

pub fn set_paint_fill(paint: &mut Paint, fill: &Fill, bounding_box: &Rect, remove_alpha: bool) {
    if remove_alpha {
        paint.set_color(skia::Color::BLACK);
        paint.set_alpha(255);
        return;
    }
    let shader = get_fill_shader(fill, bounding_box);
    if let Some(shader) = shader {
        paint.set_shader(shader);
    }
}
