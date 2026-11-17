use crate::function::Function;
use crate::num::{bounded, f64_to_usize, unit_to_u8};
use crate::object::{Dict, Object, Resolver};
use core::mem;

const MAX_DEPTH: usize = 4;
const MAX_COMPONENTS: usize = 32;
const MAX_INDEXED: usize = 255;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ColorSpace {
    Cmyk,
    Gray,
    Indexed(Box<Indexed>),
    Lab(Box<Lab>),
    Pattern(Option<Box<Self>>),
    Rgb,
    Tinted(Box<Tinted>),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Indexed {
    base: ColorSpace,
    hival: usize,
    lookup: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Lab {
    range: [f64; 4],
    white: [f64; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Tinted {
    alternate: ColorSpace,
    components: usize,
    function: Option<Function>,
    invisible: bool,
}

impl ColorSpace {
    pub(crate) fn components(&self) -> usize {
        match self {
            Self::Gray | Self::Indexed(_) => 1,
            Self::Rgb | Self::Lab(_) => 3,
            Self::Cmyk => 4,
            Self::Pattern(_) => 0,
            Self::Tinted(tinted) => tinted.components,
        }
    }

    pub(crate) fn default_decode(&self, bits: u32) -> Vec<f64> {
        match self {
            Self::Indexed(_) => vec![0.0, f64::from((1_u32 << bits.min(16)).saturating_sub(1))],
            Self::Lab(lab) => vec![
                0.0,
                100.0,
                lab.range[0],
                lab.range[1],
                lab.range[2],
                lab.range[3],
            ],
            Self::Cmyk | Self::Gray | Self::Pattern(_) | Self::Rgb | Self::Tinted(_) => {
                [0.0, 1.0].repeat(self.components())
            }
        }
    }

    pub(crate) fn initial(&self) -> Vec<f64> {
        match self {
            Self::Cmyk => vec![0.0, 0.0, 0.0, 1.0],
            Self::Tinted(tinted) => vec![1.0; tinted.components],
            Self::Gray | Self::Indexed(_) | Self::Lab(_) | Self::Pattern(_) | Self::Rgb => {
                vec![0.0; self.components()]
            }
        }
    }

    pub(crate) const fn is_invisible(&self) -> bool {
        matches!(self, Self::Tinted(tinted) if tinted.invisible)
    }

    pub(crate) fn parse(
        resolver: &dyn Resolver,
        object: &Object,
        named: Option<&Dict>,
    ) -> Option<Self> {
        parse_space(resolver, object, named, 0)
    }

    pub(crate) fn rgb(&self, components: &[f64], scratch: &mut Vec<f64>) -> [f64; 3] {
        let at =
            |index: usize| bounded(components.get(index).copied().unwrap_or(0.0_f64), 0.0, 1.0);
        match self {
            Self::Gray | Self::Pattern(None) => {
                let gray = at(0);
                [gray, gray, gray]
            }
            Self::Rgb => [at(0), at(1), at(2)],
            Self::Cmyk => cmyk_to_rgb(at(0), at(1), at(2), at(3)),
            Self::Lab(lab) => lab.rgb(components),
            Self::Indexed(indexed) => {
                indexed.rgb(components.first().copied().unwrap_or(0.0), scratch)
            }
            Self::Pattern(Some(base)) => base.rgb(components, scratch),
            Self::Tinted(tinted) => tinted.rgb(components, scratch),
        }
    }

    pub(crate) fn rgba(&self, components: &[f64], alpha: f64, scratch: &mut Vec<f64>) -> [u8; 4] {
        let [red, green, blue] = self.rgb(components, scratch);
        [
            unit_to_u8(red),
            unit_to_u8(green),
            unit_to_u8(blue),
            unit_to_u8(alpha),
        ]
    }
}

impl Indexed {
    fn rgb(&self, index: f64, scratch: &mut Vec<f64>) -> [f64; 3] {
        let slot = f64_to_usize(index.round().max(0.0)).min(self.hival);
        let count = self.base.components();
        let start = slot.saturating_mul(count);
        let mut values = [0.0_f64; 4];
        for (offset, value) in values.iter_mut().enumerate().take(count.min(4)) {
            *value = f64::from(
                self.lookup
                    .get(start.saturating_add(offset))
                    .copied()
                    .unwrap_or(0),
            ) / 255.0_f64;
        }
        if let ColorSpace::Lab(lab) = &self.base {
            let decode = [
                values[0] * 100.0_f64,
                lab.range[0] + values[1] * (lab.range[1] - lab.range[0]),
                lab.range[2] + values[2] * (lab.range[3] - lab.range[2]),
            ];
            return lab.rgb(&decode);
        }
        self.base
            .rgb(values.get(..count.min(4)).unwrap_or_default(), scratch)
    }
}

impl Lab {
    fn rgb(&self, components: &[f64]) -> [f64; 3] {
        let at = |index: usize| components.get(index).copied().unwrap_or(0.0_f64);
        let lightness = bounded(at(0), 0.0, 100.0);
        let a_star = bounded(at(1), self.range[0], self.range[1]);
        let b_star = bounded(at(2), self.range[2], self.range[3]);
        let fy = (lightness + 16.0_f64) / 116.0_f64;
        let fx = fy + a_star / 500.0_f64;
        let fz = fy - b_star / 200.0_f64;
        let inverse = |value: f64| {
            if value > 6.0_f64 / 29.0_f64 {
                value * value * value
            } else {
                3.0_f64 * (6.0_f64 / 29.0_f64) * (6.0_f64 / 29.0_f64) * (value - 4.0_f64 / 29.0_f64)
            }
        };
        let x = self.white[0] * inverse(fx);
        let y = self.white[1] * inverse(fy);
        let z_value = self.white[2] * inverse(fz);
        let linear = [
            3.240_454_2_f64 * x - 1.537_138_5_f64 * y - 0.498_531_4_f64 * z_value,
            -0.969_266_f64 * x + 1.876_010_8_f64 * y + 0.041_556_f64 * z_value,
            0.055_643_4_f64 * x - 0.204_025_9_f64 * y + 1.057_225_2_f64 * z_value,
        ];
        linear.map(|channel| {
            let clamped = bounded(channel, 0.0, 1.0);
            if clamped <= 0.003_130_8_f64 {
                12.92_f64 * clamped
            } else {
                1.055_f64 * clamped.powf(1.0 / 2.4) - 0.055_f64
            }
        })
    }
}

impl Tinted {
    fn rgb(&self, components: &[f64], scratch: &mut Vec<f64>) -> [f64; 3] {
        let Some(function) = &self.function else {
            let tint = components.first().copied().unwrap_or(0.0_f64);
            return [1.0 - tint, 1.0 - tint, 1.0 - tint];
        };
        let mut output = mem::take(scratch);
        function.eval(components, &mut output);
        let rgb = self.alternate.rgb(&output, scratch);
        *scratch = output;
        rgb
    }
}

pub(crate) fn cmyk_to_rgb(cyan: f64, magenta: f64, yellow: f64, black: f64) -> [f64; 3] {
    let white = 1.0_f64 - black;
    [
        (1.0 - cyan) * white,
        (1.0 - magenta) * white,
        (1.0 - yellow) * white,
    ]
}

fn parse_space(
    resolver: &dyn Resolver,
    object: &Object,
    named: Option<&Dict>,
    depth: usize,
) -> Option<ColorSpace> {
    if depth > MAX_DEPTH {
        return None;
    }
    let target = resolver.resolve(object).ok()?;
    if let Some(name) = target.as_name() {
        if let Some(space) = device_space(name) {
            return Some(space);
        }
        if name == b"Pattern" {
            return Some(ColorSpace::Pattern(None));
        }
        let entry = named?.get(name)?;
        return parse_space(resolver, entry, None, depth.saturating_add(1));
    }
    let items = target.as_array()?;
    let family = items.first()?.as_name()?;
    let argument = |index: usize| items.get(index);
    match family {
        b"ICCBased" => {
            let stream = resolver.resolve(argument(1)?).ok()?;
            let dict = stream.as_dict()?;
            if let Some(alternate) = dict.get(b"Alternate")
                && let Some(space) =
                    parse_space(resolver, alternate, named, depth.saturating_add(1))
                && space.components() > 0
            {
                return Some(space);
            }
            let count = dict
                .get(b"N")
                .and_then(|value| resolver.resolve(value).ok())
                .and_then(|value| value.as_integer());
            match count {
                Some(1) => Some(ColorSpace::Gray),
                Some(4) => Some(ColorSpace::Cmyk),
                _ => Some(ColorSpace::Rgb),
            }
        }
        b"CalRGB" => Some(ColorSpace::Rgb),
        b"CalGray" => Some(ColorSpace::Gray),
        b"CalCMYK" => Some(ColorSpace::Cmyk),
        b"Lab" => {
            let params = argument(1).and_then(|value| resolver.resolve(value).ok());
            let dict = params.as_deref().and_then(Object::as_dict);
            let read = |key: &[u8]| -> Vec<f64> {
                dict.and_then(|inner| inner.get(key))
                    .and_then(Object::as_array)
                    .map(|values| values.iter().filter_map(Object::as_number).collect())
                    .unwrap_or_default()
            };
            let white = read(b"WhitePoint");
            let range = read(b"Range");
            Some(ColorSpace::Lab(Box::new(Lab {
                white: [
                    white.first().copied().unwrap_or(0.9505),
                    white.get(1).copied().unwrap_or(1.0),
                    white.get(2).copied().unwrap_or(1.089),
                ],
                range: [
                    range.first().copied().unwrap_or(-100.0),
                    range.get(1).copied().unwrap_or(100.0),
                    range.get(2).copied().unwrap_or(-100.0),
                    range.get(3).copied().unwrap_or(100.0),
                ],
            })))
        }
        b"Indexed" | b"I" => parse_indexed(resolver, items, named, depth),
        b"Separation" | b"DeviceN" => parse_tinted(resolver, items, named, depth),
        b"Pattern" => Some(ColorSpace::Pattern(
            argument(1)
                .and_then(|value| parse_space(resolver, value, named, depth.saturating_add(1)))
                .map(Box::new),
        )),
        name => device_space(name),
    }
}

fn parse_indexed(
    resolver: &dyn Resolver,
    items: &[Object],
    named: Option<&Dict>,
    depth: usize,
) -> Option<ColorSpace> {
    let argument = |index: usize| items.get(index);
    let base = parse_space(resolver, argument(1)?, named, depth.saturating_add(1))?;
    let hival = argument(2)
        .and_then(Object::as_number)
        .map_or(0, f64_to_usize)
        .min(MAX_INDEXED);
    let table = resolver.resolve(argument(3)?).ok()?;
    let lookup = match &*table {
        Object::String(bytes) => bytes.clone(),
        Object::Stream(stream) => resolver.stream_data(stream).ok()?,
        Object::Array(_)
        | Object::Bool(_)
        | Object::Dict(_)
        | Object::Integer(_)
        | Object::Name(_)
        | Object::Null
        | Object::Real(_)
        | Object::Ref(_) => return None,
    };
    Some(ColorSpace::Indexed(Box::new(Indexed {
        base,
        hival,
        lookup,
    })))
}

fn parse_tinted(
    resolver: &dyn Resolver,
    items: &[Object],
    named: Option<&Dict>,
    depth: usize,
) -> Option<ColorSpace> {
    let argument = |index: usize| items.get(index);
    let family = items.first()?.as_name()?;
    let components = if family == b"Separation" {
        1
    } else {
        resolver
            .resolve(argument(1)?)
            .ok()?
            .as_array()
            .map_or(1, <[Object]>::len)
            .clamp(1, MAX_COMPONENTS)
    };
    let colorants = resolver.resolve(argument(1)?).ok();
    let invisible = colorants.as_deref().is_some_and(|value| match value {
        Object::Name(name) => name == b"None",
        Object::Array(entries) => {
            !entries.is_empty() && entries.iter().all(|entry| entry.as_name() == Some(b"None"))
        }
        Object::Bool(_)
        | Object::Dict(_)
        | Object::Integer(_)
        | Object::Null
        | Object::Real(_)
        | Object::Ref(_)
        | Object::Stream(_)
        | Object::String(_) => false,
    });
    let alternate = parse_space(resolver, argument(2)?, named, depth.saturating_add(1))
        .unwrap_or(ColorSpace::Gray);
    let function = argument(3).and_then(|value| Function::parse(resolver, value));
    Some(ColorSpace::Tinted(Box::new(Tinted {
        alternate,
        components,
        function,
        invisible,
    })))
}

const fn device_space(name: &[u8]) -> Option<ColorSpace> {
    match name {
        b"DeviceGray" | b"G" | b"CalGray" => Some(ColorSpace::Gray),
        b"DeviceRGB" | b"RGB" | b"CalRGB" => Some(ColorSpace::Rgb),
        b"DeviceCMYK" | b"CMYK" => Some(ColorSpace::Cmyk),
        _ => None,
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

    fn name(value: &str) -> Object {
        Object::Name(value.as_bytes().to_vec())
    }

    fn rgb(space: &ColorSpace, components: &[f64]) -> [u8; 4] {
        space.rgba(components, 1.0, &mut Vec::new())
    }

    #[test]
    fn device_spaces_convert_to_rgb() {
        let gray = ColorSpace::parse(&Direct, &name("DeviceGray"), None).unwrap();
        assert_eq!(rgb(&gray, &[0.5_f64]), [128, 128, 128, 255]);
        let cmyk = ColorSpace::parse(&Direct, &name("DeviceCMYK"), None).unwrap();
        assert_eq!(
            rgb(&cmyk, &[0.0_f64, 0.0_f64, 0.0_f64, 1.0_f64]),
            [0, 0, 0, 255]
        );
        assert_eq!(
            rgb(&cmyk, &[1.0_f64, 0.0_f64, 0.0_f64, 0.0_f64]),
            [0, 255, 255, 255]
        );
        assert_eq!(cmyk.initial(), vec![0.0_f64, 0.0_f64, 0.0_f64, 1.0_f64]);
    }

    #[test]
    fn indexed_and_separation_use_their_bases() {
        let indexed = Object::Array(vec![
            name("Indexed"),
            name("DeviceRGB"),
            Object::Integer(1),
            Object::String(vec![255, 0, 0, 0, 0, 255]),
        ]);
        let space = ColorSpace::parse(&Direct, &indexed, None).unwrap();
        assert_eq!(rgb(&space, &[1.0_f64]), [0, 0, 255, 255]);
        assert_eq!(rgb(&space, &[9.0_f64]), [0, 0, 255, 255]);
        assert_eq!(space.default_decode(8), vec![0.0_f64, 255.0_f64]);
        let tint = Object::Dict(Dict {
            entries: vec![
                (b"FunctionType".to_vec(), Object::Integer(2)),
                (
                    b"Domain".to_vec(),
                    Object::Array(vec![Object::Integer(0), Object::Integer(1)]),
                ),
                (b"C0".to_vec(), Object::Array(vec![Object::Integer(0); 4])),
                (
                    b"C1".to_vec(),
                    Object::Array(vec![
                        Object::Integer(0),
                        Object::Integer(1),
                        Object::Integer(0),
                        Object::Integer(0),
                    ]),
                ),
                (b"N".to_vec(), Object::Integer(1)),
            ],
        });
        let separation = Object::Array(vec![
            name("Separation"),
            name("Spot"),
            name("DeviceCMYK"),
            tint,
        ]);
        let spot = ColorSpace::parse(&Direct, &separation, None).unwrap();
        assert_eq!(rgb(&spot, &[1.0_f64]), [255, 0, 255, 255]);
        assert_eq!(spot.initial(), vec![1.0_f64]);
        let none = Object::Array(vec![
            name("Separation"),
            name("None"),
            name("DeviceGray"),
            Object::Null,
        ]);
        assert!(
            ColorSpace::parse(&Direct, &none, None)
                .unwrap()
                .is_invisible()
        );
    }

    #[test]
    fn named_spaces_resolve_through_resources_and_bounded_depth() {
        let resources = Dict {
            entries: vec![
                (b"CS0".to_vec(), name("DeviceRGB")),
                (b"Loop".to_vec(), name("Loop")),
            ],
        };
        assert_eq!(
            ColorSpace::parse(&Direct, &name("CS0"), Some(&resources)),
            Some(ColorSpace::Rgb)
        );
        assert_eq!(
            ColorSpace::parse(&Direct, &name("Loop"), Some(&resources)),
            None
        );
        let lab = Object::Array(vec![name("Lab"), Object::Dict(Dict::default())]);
        let space = ColorSpace::parse(&Direct, &lab, None).unwrap();
        let white = rgb(&space, &[100.0_f64, 0.0_f64, 0.0_f64]);
        assert!(white.iter().take(3).all(|channel| *channel >= 250));
    }
}
