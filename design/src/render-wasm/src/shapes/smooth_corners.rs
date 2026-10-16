// zvena: Figma's corner smoothing ("squircle" corners) for rects and boards.
//
// Same geometry as the SVG renderer (`app.main.ui.shapes.attrs/smooth-rect-path`,
// after figma-squircle by Phong Pham, MIT): every rounded corner is a cubic, a
// circular arc and a cubic, so the curvature eases in along the edges instead
// of starting abruptly where the plain arc begins. With smoothing 0 the outline
// is the regular rounded rect, and callers keep using `RRect` for that case.

use skia_safe::{self as skia, Point, Rect};

use super::Corners;

/// Smoothing at or below this is drawn as the regular rounded rect.
pub const MIN_CORNER_SMOOTHING: f32 = 0.001;

pub fn has_smoothing(smoothing: f32) -> bool {
    smoothing > MIN_CORNER_SMOOTHING
}

/// Path parameters of one smoothed corner (figma-squircle naming). Lengths
/// are measured from the rect corner along the incoming edge (`u`) and the
/// outgoing edge (`v`).
#[derive(Debug, Clone, Copy)]
struct SmoothCorner {
    radius: f32,
    // Length of each edge taken by the corner
    p: f32,
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    // Extent of the circular arc along each axis
    l: f32,
    // Angle (radians) between the edge and the arc tangent at the arc ends
    beta: f32,
    // Sweep of the circular arc (radians)
    arc: f32,
}

fn smooth_corner(radius: f32, smoothing: f32, budget: f32) -> SmoothCorner {
    let radius = radius.max(0.0).min(budget);
    let p = ((1.0 + smoothing) * radius).min(budget);
    // Not enough room for the full smoothing: reduce it (figma-squircle's
    // default, preserveSmoothing = false)
    let smoothing = if radius > 0.0 {
        smoothing.min(budget / radius - 1.0).max(0.0)
    } else {
        0.0
    };

    let arc = (90.0 * (1.0 - smoothing)).to_radians();
    let l = (arc / 2.0).sin() * radius * std::f32::consts::SQRT_2;
    let alpha = (std::f32::consts::FRAC_PI_2 - arc) / 2.0;
    let p3_p4 = radius * (alpha / 2.0).tan();
    let beta = (45.0 * smoothing).to_radians();
    let c = p3_p4 * beta.cos();
    let d = c * beta.tan();
    let b = (p - l - c - d) / 3.0;
    let a = 2.0 * b;

    SmoothCorner {
        radius,
        p,
        a,
        b,
        c,
        d,
        l,
        beta,
        arc,
    }
}

/// Appends one corner. The builder must be at `p` before `corner` along the
/// incoming edge; `u` is the direction of the incoming edge and `v` the one
/// of the outgoing edge. Ends at `p` after `corner` along the outgoing edge.
fn add_corner(
    pb: &mut skia::PathBuilder,
    corner: Point,
    u: (f32, f32),
    v: (f32, f32),
    k: &SmoothCorner,
) {
    // The point `du` along `u` and `dv` along `v` from the corner
    let at = |du: f32, dv: f32| {
        Point::new(
            corner.x + u.0 * du + v.0 * dv,
            corner.y + u.1 * du + v.1 * dv,
        )
    };

    if k.radius <= 0.0 {
        pb.line_to(corner);
        return;
    }

    // Ease in: from the edge to the start of the arc
    let s_u = -k.p + k.a + k.b + k.c;
    let s_v = k.d;
    pb.cubic_to(at(-k.p + k.a, 0.0), at(-k.p + k.a + k.b, 0.0), at(s_u, s_v));

    // The circular arc, as an exact conic: control point where the tangents
    // at both ends meet (they are symmetric around the corner diagonal)
    let e_u = s_u + k.l;
    let e_v = s_v + k.l;
    let (sin_b, cos_b) = k.beta.sin_cos();
    let t = k.l / (cos_b + sin_b);
    pb.conic_to(
        at(s_u + t * cos_b, s_v + t * sin_b),
        at(e_u, e_v),
        (k.arc / 2.0).cos(),
    );

    // Ease out: from the end of the arc to the next edge
    pb.cubic_to(
        at(e_u + k.d, e_v + k.c),
        at(e_u + k.d, e_v + k.b + k.c),
        at(e_u + k.d, e_v + k.a + k.b + k.c),
    );
}

/// The outline of `rect` with `corners` (Skia order: top-left, top-right,
/// bottom-right, bottom-left) smoothed by `smoothing` (0..1). Clockwise,
/// starting on the top edge, like `attrs/smooth-rect-path`.
pub fn smooth_rect_path(rect: &Rect, corners: &Corners, smoothing: f32) -> skia::Path {
    let smoothing = if smoothing.is_finite() {
        smoothing.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let budget = (rect.width().min(rect.height()) / 2.0).max(0.0);
    // Elliptic radii (per-side stroke bands) use the larger axis
    let radius = |i: usize| corners[i].x.max(corners[i].y);

    let tl = smooth_corner(radius(0), smoothing, budget);
    let tr = smooth_corner(radius(1), smoothing, budget);
    let br = smooth_corner(radius(2), smoothing, budget);
    let bl = smooth_corner(radius(3), smoothing, budget);

    let (left, top, right, bottom) = (rect.left, rect.top, rect.right, rect.bottom);

    let mut pb = skia::PathBuilder::new();
    pb.move_to((right - tr.p, top));
    add_corner(&mut pb, Point::new(right, top), (1.0, 0.0), (0.0, 1.0), &tr);
    pb.line_to((right, bottom - br.p));
    add_corner(
        &mut pb,
        Point::new(right, bottom),
        (0.0, 1.0),
        (-1.0, 0.0),
        &br,
    );
    pb.line_to((left + bl.p, bottom));
    add_corner(
        &mut pb,
        Point::new(left, bottom),
        (-1.0, 0.0),
        (0.0, -1.0),
        &bl,
    );
    pb.line_to((left, top + tl.p));
    add_corner(&mut pb, Point::new(left, top), (0.0, -1.0), (1.0, 0.0), &tl);
    pb.close();
    pb.detach()
}

/// The smoothed outline, or None when the regular rect/rrect applies.
pub fn smooth_corners_path(
    rect: &Rect,
    corners: &Option<Corners>,
    smoothing: f32,
) -> Option<skia::Path> {
    match corners {
        Some(corners) if has_smoothing(smoothing) => {
            Some(smooth_rect_path(rect, corners, smoothing))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corners(r: f32) -> Corners {
        [(r, r).into(), (r, r).into(), (r, r).into(), (r, r).into()]
    }

    #[test]
    fn test_no_smoothing_is_a_rounded_rect() {
        let k = smooth_corner(10.0, 0.0, 50.0);
        assert!((k.p - 10.0).abs() < 1e-4);
        assert!(k.a.abs() < 1e-4 && k.b.abs() < 1e-4);
        assert!(k.c.abs() < 1e-4 && k.d.abs() < 1e-4);
        assert!((k.l - 10.0).abs() < 1e-4);
    }

    #[test]
    fn test_corner_lengths_add_up() {
        let k = smooth_corner(20.0, 0.6, 100.0);
        assert!((k.p - 32.0).abs() < 1e-3);
        assert!((k.a + k.b + k.c + k.d + k.l - k.p).abs() < 1e-3);
    }

    #[test]
    fn test_path_stays_inside_rect() {
        let rect = Rect::from_xywh(10.0, 20.0, 100.0, 60.0);
        let path = smooth_rect_path(&rect, &corners(24.0), 0.6);
        let bounds = path.compute_tight_bounds();
        assert!(bounds.left >= rect.left - 1e-3);
        assert!(bounds.top >= rect.top - 1e-3);
        assert!(bounds.right <= rect.right + 1e-3);
        assert!(bounds.bottom <= rect.bottom + 1e-3);
    }

    #[test]
    fn test_no_path_without_smoothing() {
        let rect = Rect::from_xywh(0.0, 0.0, 10.0, 10.0);
        assert!(smooth_corners_path(&rect, &Some(corners(2.0)), 0.0).is_none());
        assert!(smooth_corners_path(&rect, &None, 0.6).is_none());
        assert!(smooth_corners_path(&rect, &Some(corners(2.0)), 0.6).is_some());
    }
}
