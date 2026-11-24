use crate::color::ColorSpace;
use crate::display::{Gradient, Matrix};
use crate::function::Function;
use crate::num::usize_to_f64;
use crate::object::{Dict, Object, Resolver, numbers};

const STOPS: usize = 48;
const MAX_FUNCTIONS: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GradientPaint {
    pub coords: [f64; 6],
    pub extend: (bool, bool),
    pub matrix: Matrix,
    pub radial: bool,
    pub stops: Vec<(f64, [u8; 4])>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Shading {
    Flat([u8; 4]),
    Gradient(GradientPaint),
}

impl GradientPaint {
    pub(crate) fn as_gradient(&self) -> Gradient<'_> {
        Gradient {
            coords: self.coords,
            extend: self.extend,
            radial: self.radial,
            stops: &self.stops,
        }
    }

    pub(crate) fn middle_color(&self) -> [u8; 4] {
        self.stops
            .get(self.stops.len() >> 1_u32)
            .map_or([0, 0, 0, 255], |(_, color)| *color)
    }
}

fn functions(resolver: &dyn Resolver, dict: &Dict) -> Vec<Function> {
    let Some(entry) = dict.get(b"Function") else {
        return Vec::new();
    };
    let Ok(target) = resolver.resolve(entry) else {
        return Vec::new();
    };
    target.as_array().map_or_else(
        || Function::parse(resolver, &target).into_iter().collect(),
        |items| {
            items
                .iter()
                .take(MAX_FUNCTIONS)
                .filter_map(|item| Function::parse(resolver, item))
                .collect()
        },
    )
}

fn evaluate(
    functions: &[Function],
    space: &ColorSpace,
    input: f64,
    alpha: f64,
    scratch: &mut Vec<f64>,
    out: &mut Vec<f64>,
) -> [u8; 4] {
    let mut components: Vec<f64> = Vec::with_capacity(4);
    if let [single] = functions {
        single.eval(&[input], out);
        components.extend_from_slice(out);
    } else {
        for function in functions {
            function.eval(&[input], out);
            components.push(out.first().copied().unwrap_or(0.0_f64));
        }
    }
    space.rgba(&components, alpha, scratch)
}

pub(crate) fn parse_shading(
    resolver: &dyn Resolver,
    object: &Object,
    named: Option<&Dict>,
    alpha: f64,
) -> Option<Shading> {
    let target = resolver.resolve(object).ok()?;
    let dict = target.as_dict()?;
    let kind = dict
        .get(b"ShadingType")
        .and_then(|value| resolver.resolve(value).ok())
        .and_then(|value| value.as_integer())?;
    let space = ColorSpace::parse(resolver, dict.get(b"ColorSpace")?, named)?;
    let functions = functions(resolver, dict);
    let mut scratch = Vec::new();
    let mut out = Vec::new();
    match kind {
        2 | 3 => {
            if functions.is_empty() {
                return None;
            }
            let coords = numbers(resolver, dict, b"Coords");
            let domain = numbers(resolver, dict, b"Domain");
            let t0 = domain.first().copied().unwrap_or(0.0);
            let t1 = domain.get(1).copied().unwrap_or(1.0);
            let extend = dict
                .get(b"Extend")
                .and_then(|value| resolver.resolve(value).ok())
                .and_then(|value| {
                    let items = value.as_array()?;
                    Some((
                        matches!(items.first(), Some(Object::Bool(true))),
                        matches!(items.get(1), Some(Object::Bool(true))),
                    ))
                })
                .unwrap_or((false, false));
            let radial = kind == 3;
            let at = |index: usize| coords.get(index).copied().unwrap_or(0.0_f64);
            let coords_next = if radial {
                [at(0), at(1), at(2), at(3), at(4), at(5)]
            } else {
                [at(0), at(1), at(2), at(3), 0.0, 0.0]
            };
            let last = usize_to_f64(STOPS.saturating_sub(1));
            let stops = (0..STOPS)
                .map(|step| {
                    let fraction = usize_to_f64(step) / last;
                    let color = evaluate(
                        &functions,
                        &space,
                        t0 + (t1 - t0) * fraction,
                        alpha,
                        &mut scratch,
                        &mut out,
                    );
                    (fraction, color)
                })
                .collect();
            Some(Shading::Gradient(GradientPaint {
                coords: coords_next,
                extend,
                matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                radial,
                stops,
            }))
        }
        1 => {
            let domain = numbers(resolver, dict, b"Domain");
            let center = [
                f64::midpoint(
                    domain.first().copied().unwrap_or(0.0),
                    domain.get(1).copied().unwrap_or(1.0),
                ),
                f64::midpoint(
                    domain.get(2).copied().unwrap_or(0.0),
                    domain.get(3).copied().unwrap_or(1.0),
                ),
            ];
            let mut components = Vec::new();
            for function in &functions {
                function.eval(&center, &mut out);
                components.extend_from_slice(&out);
            }
            Some(Shading::Flat(space.rgba(&components, alpha, &mut scratch)))
        }
        _ => {
            let value = dict
                .get(b"Background")
                .and_then(|value| resolver.resolve(value).ok())?;
            let components: Vec<f64> = value
                .as_array()?
                .iter()
                .filter_map(Object::as_number)
                .collect();
            Some(Shading::Flat(space.rgba(&components, alpha, &mut scratch)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::Outcome;
    use crate::object::Stream;
    use alloc::rc::Rc;

    struct Direct;

    impl Resolver for Direct {
        fn resolve(&self, object: &Object) -> Outcome<Rc<Object>> {
            Ok(Rc::new(object.clone()))
        }

        fn stream_data(&self, _stream: &Stream) -> Outcome<Vec<u8>> {
            Ok(Vec::new())
        }
    }

    fn dict(entries: Vec<(&str, Object)>) -> Object {
        Object::Dict(Dict {
            entries: entries
                .into_iter()
                .map(|(key, value)| (key.as_bytes().to_vec(), value))
                .collect(),
        })
    }

    fn reals(values: &[f64]) -> Object {
        Object::Array(values.iter().map(|value| Object::Real(*value)).collect())
    }

    #[test]
    fn axial_shading_samples_stops_from_its_function() {
        let function = dict(vec![
            ("FunctionType", Object::Integer(2)),
            ("Domain", reals(&[0.0_f64, 1.0_f64])),
            ("C0", reals(&[1.0_f64, 0.0_f64, 0.0_f64])),
            ("C1", reals(&[0.0_f64, 0.0_f64, 1.0_f64])),
            ("N", Object::Integer(1)),
        ]);
        let shading = dict(vec![
            ("ShadingType", Object::Integer(2)),
            ("ColorSpace", Object::Name(b"DeviceRGB".to_vec())),
            ("Coords", reals(&[0.0_f64, 0.0_f64, 100.0_f64, 0.0_f64])),
            ("Function", function),
            (
                "Extend",
                Object::Array(vec![Object::Bool(true), Object::Bool(false)]),
            ),
        ]);
        let Some(Shading::Gradient(gradient)) = parse_shading(&Direct, &shading, None, 1.0) else {
            panic!("expected gradient");
        };
        assert_eq!(gradient.stops.len(), STOPS);
        assert_eq!(gradient.stops.first().unwrap().1, [255, 0, 0, 255]);
        assert_eq!(gradient.stops.last().unwrap().1, [0, 0, 255, 255]);
        assert_eq!(gradient.extend, (true, false));
        assert_eq!(
            gradient.coords,
            [0.0_f64, 0.0_f64, 100.0_f64, 0.0_f64, 0.0_f64, 0.0_f64]
        );
        assert!(!gradient.radial);
    }

    #[test]
    fn unsupported_shadings_fall_back_to_background_or_nothing() {
        let mesh = dict(vec![
            ("ShadingType", Object::Integer(4)),
            ("ColorSpace", Object::Name(b"DeviceGray".to_vec())),
            ("Background", reals(&[0.5_f64])),
        ]);
        assert_eq!(
            parse_shading(&Direct, &mesh, None, 1.0),
            Some(Shading::Flat([128, 128, 128, 255]))
        );
        let bare = dict(vec![
            ("ShadingType", Object::Integer(6)),
            ("ColorSpace", Object::Name(b"DeviceGray".to_vec())),
        ]);
        assert_eq!(parse_shading(&Direct, &bare, None, 1.0), None);
    }
}
