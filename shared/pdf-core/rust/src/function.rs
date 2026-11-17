use crate::num::{bounded, f64_to_i64, f64_to_usize, i64_to_f64, parse_decimal, usize_to_f64};
use crate::object::{Dict, Object, Resolver};
use core::f64::consts::{FRAC_PI_2, LN_10, PI};

const MAX_DEPTH: usize = 6;
const MAX_OUTPUTS: usize = 32;
const MAX_SAMPLES: usize = 1 << 22;
const MAX_INPUTS: usize = 4;
const MAX_PROGRAM: usize = 4096;
const MAX_STACK: usize = 100;
const MAX_STEPS: usize = 20_000;
const MAX_STITCHED: usize = 256;
const PS_ABS: u8 = 1;
const PS_ADD: u8 = 2;
const PS_AND: u8 = 3;
const PS_ATAN: u8 = 4;
const PS_BITSHIFT: u8 = 5;
const PS_CEILING: u8 = 6;
const PS_COPY: u8 = 7;
const PS_COS: u8 = 8;
const PS_CVI: u8 = 9;
const PS_CVR: u8 = 10;
const PS_DIV: u8 = 11;
const PS_DUP: u8 = 12;
const PS_EQ: u8 = 13;
const PS_EXCH: u8 = 14;
const PS_EXP: u8 = 15;
const PS_FALSE: u8 = 16;
const PS_FLOOR: u8 = 17;
const PS_GE: u8 = 18;
const PS_GT: u8 = 19;
const PS_IDIV: u8 = 20;
const PS_INDEX: u8 = 21;
const PS_LE: u8 = 22;
const PS_LN: u8 = 23;
const PS_LOG: u8 = 24;
const PS_LT: u8 = 25;
const PS_MOD: u8 = 26;
const PS_MUL: u8 = 27;
const PS_NE: u8 = 28;
const PS_NEG: u8 = 29;
const PS_NOT: u8 = 30;
const PS_OR: u8 = 31;
const PS_POP: u8 = 32;
const PS_ROLL: u8 = 33;
const PS_ROUND: u8 = 34;
const PS_SIN: u8 = 35;
const PS_SQRT: u8 = 36;
const PS_SUB: u8 = 37;
const PS_TRUE: u8 = 38;
const PS_TRUNCATE: u8 = 39;
const PS_XOR: u8 = 40;
const PS_NAMES: [(&[u8], u8); 40] = [
    (b"abs", PS_ABS),
    (b"add", PS_ADD),
    (b"and", PS_AND),
    (b"atan", PS_ATAN),
    (b"bitshift", PS_BITSHIFT),
    (b"ceiling", PS_CEILING),
    (b"copy", PS_COPY),
    (b"cos", PS_COS),
    (b"cvi", PS_CVI),
    (b"cvr", PS_CVR),
    (b"div", PS_DIV),
    (b"dup", PS_DUP),
    (b"eq", PS_EQ),
    (b"exch", PS_EXCH),
    (b"exp", PS_EXP),
    (b"false", PS_FALSE),
    (b"floor", PS_FLOOR),
    (b"ge", PS_GE),
    (b"gt", PS_GT),
    (b"idiv", PS_IDIV),
    (b"index", PS_INDEX),
    (b"le", PS_LE),
    (b"ln", PS_LN),
    (b"log", PS_LOG),
    (b"lt", PS_LT),
    (b"mod", PS_MOD),
    (b"mul", PS_MUL),
    (b"ne", PS_NE),
    (b"neg", PS_NEG),
    (b"not", PS_NOT),
    (b"or", PS_OR),
    (b"pop", PS_POP),
    (b"roll", PS_ROLL),
    (b"round", PS_ROUND),
    (b"sin", PS_SIN),
    (b"sqrt", PS_SQRT),
    (b"sub", PS_SUB),
    (b"true", PS_TRUE),
    (b"truncate", PS_TRUNCATE),
    (b"xor", PS_XOR),
];

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Function {
    Exponential(Exponential),
    PostScript(PostScript),
    Sampled(Sampled),
    Stitching(Stitching),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Exponential {
    c0: Vec<f64>,
    c1: Vec<f64>,
    domain: [f64; 2],
    exponent: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PostScript {
    domain: Vec<f64>,
    program: Vec<PsOp>,
    range: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Sampled {
    decode: Vec<f64>,
    domain: Vec<f64>,
    encode: Vec<f64>,
    outputs: usize,
    range: Vec<f64>,
    samples: Vec<f64>,
    size: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Stitching {
    bounds: Vec<f64>,
    domain: [f64; 2],
    encode: Vec<f64>,
    functions: Vec<Function>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PsOp {
    Jump(usize),
    JumpUnless(usize),
    Number(f64),
    Operator(u8),
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Value {
    boolean: bool,
    value: f64,
}

impl Value {
    const fn flag(state: bool) -> Self {
        Self {
            boolean: true,
            value: if state { 1.0 } else { 0.0 },
        }
    }

    const fn is_true(self) -> bool {
        self.boolean && self.value > 0.5
    }

    const fn number(self) -> f64 {
        self.value
    }

    const fn real(value: f64) -> Self {
        Self {
            boolean: false,
            value,
        }
    }
}

impl Function {
    pub(crate) fn eval(&self, inputs: &[f64], out: &mut Vec<f64>) {
        out.clear();
        match self {
            Self::Exponential(function) => {
                function.eval(inputs.first().copied().unwrap_or(0.0_f64), out);
            }
            Self::PostScript(function) => function.eval(inputs, out),
            Self::Sampled(function) => function.eval(inputs, out),
            Self::Stitching(function) => {
                function.eval(inputs.first().copied().unwrap_or(0.0_f64), out);
            }
        }
    }

    pub(crate) fn parse(resolver: &dyn Resolver, object: &Object) -> Option<Self> {
        parse_function(resolver, object, 0)
    }
}

impl Exponential {
    fn eval(&self, input: f64, out: &mut Vec<f64>) {
        let [low, high] = self.domain;
        let clamped = bounded(input, low.min(high), high.max(low));
        let factor = if (self.exponent - 1.0).abs() < f64::EPSILON {
            clamped
        } else if clamped < 0.0_f64 && self.exponent.fract() != 0.0_f64 {
            0.0_f64
        } else {
            clamped.powf(self.exponent)
        };
        out.extend(
            self.c0
                .iter()
                .zip(&self.c1)
                .map(|(start, end)| start + factor * (end - start)),
        );
    }
}

impl PostScript {
    fn eval(&self, inputs: &[f64], out: &mut Vec<f64>) {
        let mut stack: Vec<Value> = Vec::with_capacity(16);
        for (index, input) in inputs.iter().enumerate() {
            let (low, high) = pair(&self.domain, index).unwrap_or((*input, *input));
            stack.push(Value::real(bounded(*input, low.min(high), high.max(low))));
        }
        run_program(&self.program, &mut stack);
        let count = self.range.len() >> 1_u32;
        let start = stack.len().saturating_sub(count);
        for (index, value) in stack.get(start..).unwrap_or_default().iter().enumerate() {
            let number = value.number();
            out.push(match pair(&self.range, index) {
                Some((low, high)) => bounded(number, low.min(high), high.max(low)),
                None => number,
            });
        }
        while out.len() < count {
            out.push(0.0_f64);
        }
    }
}

impl Sampled {
    fn eval(&self, inputs: &[f64], out: &mut Vec<f64>) {
        let dims = self.size.len();
        let mut base = 0_usize;
        let mut stride = 1_usize;
        let mut corners: [(usize, f64); MAX_INPUTS] = [(0, 0.0); MAX_INPUTS];
        for (dim, slot) in corners.iter_mut().enumerate().take(dims) {
            let input = inputs.get(dim).copied().unwrap_or(0.0_f64);
            let (d0, d1) = pair(&self.domain, dim).unwrap_or((0.0_f64, 1.0_f64));
            let (e0, e1) = pair(&self.encode, dim).unwrap_or((0.0_f64, 0.0_f64));
            let size = self.size.get(dim).copied().unwrap_or(1);
            let clamped = bounded(input, d0.min(d1), d0.max(d1));
            let span = d1 - d0;
            let encoded = if span.abs() < f64::EPSILON {
                e0
            } else {
                e0 + (clamped - d0) * (e1 - e0) / span
            };
            let limit = usize_to_f64(size.saturating_sub(1));
            let position = bounded(encoded, 0.0, limit);
            let floor = f64_to_usize(position.floor()).min(size.saturating_sub(1));
            let next_stride = stride.saturating_mul(self.outputs);
            base = base.saturating_add(floor.saturating_mul(next_stride));
            let frac = position - usize_to_f64(floor);
            let step = if floor.saturating_add(1) < size {
                next_stride
            } else {
                0
            };
            *slot = (step, frac);
            stride = stride.saturating_mul(size);
        }
        let corner_count = 1_usize << dims.min(MAX_INPUTS);
        for output in 0..self.outputs {
            let mut value = 0.0_f64;
            for corner in 0..corner_count {
                let mut weight = 1.0_f64;
                let mut offset = base.saturating_add(output);
                for (dim, (step, frac)) in corners.iter().enumerate().take(dims) {
                    if (corner >> dim) & 1 == 1 {
                        weight *= frac;
                        offset = offset.saturating_add(*step);
                    } else {
                        weight *= 1.0_f64 - frac;
                    }
                }
                if weight > 0.0_f64 {
                    value += weight * self.samples.get(offset).copied().unwrap_or(0.0_f64);
                }
            }
            let (low, high) = pair(&self.decode, output)
                .or_else(|| pair(&self.range, output))
                .unwrap_or((0.0_f64, 1.0_f64));
            let mapped = low + value * (high - low);
            out.push(match pair(&self.range, output) {
                Some((r0, r1)) => bounded(mapped, r0.min(r1), r0.max(r1)),
                None => mapped,
            });
        }
    }
}

impl Stitching {
    fn eval(&self, input: f64, out: &mut Vec<f64>) {
        let [low, high] = self.domain;
        let clamped = bounded(input, low.min(high), high.max(low));
        let index = self
            .bounds
            .iter()
            .position(|bound| clamped < *bound)
            .unwrap_or(self.bounds.len());
        let start = if index == 0 {
            low
        } else {
            self.bounds
                .get(index.saturating_sub(1))
                .copied()
                .unwrap_or(low)
        };
        let end = self.bounds.get(index).copied().unwrap_or(high);
        let (e0, e1) = pair(&self.encode, index).unwrap_or((0.0_f64, 1.0_f64));
        let span = end - start;
        let encoded = if span.abs() < f64::EPSILON {
            e0
        } else {
            e0 + (clamped - start) * (e1 - e0) / span
        };
        if let Some(function) = self.functions.get(index) {
            function.eval(&[encoded], out);
        }
    }
}

struct BitReader<'data> {
    data: &'data [u8],
    position: usize,
}

impl BitReader<'_> {
    fn read(&mut self, bits: usize) -> Option<u32> {
        let mut value = 0_u32;
        for _ in 0..bits {
            let byte = *self.data.get(self.position >> 3_u32)?;
            let shift = 7_usize.saturating_sub(self.position & 7);
            value = (value << 1_u32) | u32::from((byte >> shift) & 1);
            self.position = self.position.saturating_add(1);
        }
        Some(value)
    }
}

fn pair(values: &[f64], index: usize) -> Option<(f64, f64)> {
    let start = index.checked_mul(2)?;
    Some((*values.get(start)?, *values.get(start.checked_add(1)?)?))
}

fn numbers(resolver: &dyn Resolver, dict: &Dict, key: &[u8]) -> Vec<f64> {
    dict.get(key)
        .and_then(|value| resolver.resolve(value).ok())
        .and_then(|value| {
            value
                .as_array()
                .map(|items| items.iter().filter_map(Object::as_number).collect())
        })
        .unwrap_or_default()
}

fn number(resolver: &dyn Resolver, dict: &Dict, key: &[u8]) -> Option<f64> {
    let value = dict
        .get(key)
        .and_then(|value| resolver.resolve(value).ok())?;
    value.as_number()
}

fn parse_function(resolver: &dyn Resolver, object: &Object, depth: usize) -> Option<Function> {
    if depth > MAX_DEPTH {
        return None;
    }
    let target = resolver.resolve(object).ok()?;
    let dict = target.as_dict()?;
    let kind = number(resolver, dict, b"FunctionType")?;
    let domain = numbers(resolver, dict, b"Domain");
    if (kind - 2.0).abs() < 0.5_f64 {
        let c0 = numbers(resolver, dict, b"C0");
        let c1 = numbers(resolver, dict, b"C1");
        let (c0_next, c1_next) = if c0.is_empty() && c1.is_empty() {
            (vec![0.0_f64], vec![1.0_f64])
        } else if c0.is_empty() {
            (vec![0.0_f64; c1.len()], c1)
        } else if c1.is_empty() {
            let len = c0.len();
            (c0, vec![1.0_f64; len])
        } else {
            (c0, c1)
        };
        return Some(Function::Exponential(Exponential {
            c0: c0_next,
            c1: c1_next,
            domain: [
                domain.first().copied().unwrap_or(0.0),
                domain.get(1).copied().unwrap_or(1.0),
            ],
            exponent: number(resolver, dict, b"N").unwrap_or(1.0),
        }));
    }
    if (kind - 3.0).abs() < 0.5_f64 {
        let items = resolver.resolve(dict.get(b"Functions")?).ok()?;
        let mut functions = Vec::new();
        for item in items.as_array()?.iter().take(MAX_STITCHED) {
            functions.push(parse_function(resolver, item, depth.saturating_add(1))?);
        }
        return Some(Function::Stitching(Stitching {
            functions,
            bounds: numbers(resolver, dict, b"Bounds"),
            encode: numbers(resolver, dict, b"Encode"),
            domain: [
                domain.first().copied().unwrap_or(0.0),
                domain.get(1).copied().unwrap_or(1.0),
            ],
        }));
    }
    let stream = target.as_stream()?;
    let data = resolver.stream_data(stream).ok()?;
    if kind.abs() < 0.5_f64 {
        return parse_sampled(resolver, dict, domain, &data).map(Function::Sampled);
    }
    if (kind - 4.0).abs() < 0.5_f64 {
        return Some(Function::PostScript(PostScript {
            domain,
            range: numbers(resolver, dict, b"Range"),
            program: parse_program(&data)?,
        }));
    }
    None
}

fn parse_sampled(
    resolver: &dyn Resolver,
    dict: &Dict,
    domain: Vec<f64>,
    data: &[u8],
) -> Option<Sampled> {
    let range = numbers(resolver, dict, b"Range");
    let size: Vec<usize> = numbers(resolver, dict, b"Size")
        .into_iter()
        .map(|value| f64_to_usize(value).max(1))
        .collect();
    let outputs = range.len() >> 1_u32;
    if size.is_empty() || size.len() > MAX_INPUTS || outputs == 0 || outputs > MAX_OUTPUTS {
        return None;
    }
    let bits = f64_to_usize(number(resolver, dict, b"BitsPerSample")?);
    if !matches!(bits, 1 | 2 | 4 | 8 | 12 | 16 | 24 | 32) {
        return None;
    }
    let mut total = outputs;
    for dim in &size {
        total = total.checked_mul(*dim)?;
    }
    if total > MAX_SAMPLES {
        return None;
    }
    let mut encode = numbers(resolver, dict, b"Encode");
    if encode.len() < size.len().saturating_mul(2) {
        encode = size
            .iter()
            .flat_map(|dim| [0.0_f64, usize_to_f64(dim.saturating_sub(1))])
            .collect();
    }
    let max = usize_to_f64((1_usize << bits.min(32)).saturating_sub(1));
    let mut samples = Vec::with_capacity(total);
    let mut reader = BitReader { data, position: 0 };
    for _ in 0..total {
        let raw = reader.read(bits).unwrap_or(0);
        samples.push(f64::from(raw) / max);
    }
    Some(Sampled {
        decode: numbers(resolver, dict, b"Decode"),
        domain,
        encode,
        outputs,
        range,
        samples,
        size,
    })
}

fn ps_tokens(data: &[u8]) -> Vec<&[u8]> {
    let mut tokens = Vec::new();
    let mut position = 0_usize;
    while let Some(&byte) = data.get(position) {
        if matches!(byte, b'{' | b'}') {
            tokens.push(data.get(position..=position).unwrap_or_default());
            position = position.saturating_add(1);
            continue;
        }
        if byte == b'%' {
            while data
                .get(position)
                .is_some_and(|value| !matches!(value, b'\n' | b'\r'))
            {
                position = position.saturating_add(1);
            }
            continue;
        }
        if byte.is_ascii_whitespace() || byte == 0 {
            position = position.saturating_add(1);
            continue;
        }
        let start = position;
        while data.get(position).is_some_and(|value| {
            !value.is_ascii_whitespace() && !matches!(value, b'{' | b'}' | b'%' | 0)
        }) {
            position = position.saturating_add(1);
        }
        tokens.push(data.get(start..position).unwrap_or_default());
        if tokens.len() > MAX_PROGRAM {
            break;
        }
    }
    tokens
}

fn parse_program(data: &[u8]) -> Option<Vec<PsOp>> {
    let tokens = ps_tokens(data);
    let mut position = tokens
        .iter()
        .position(|token| *token == b"{")?
        .saturating_add(1);
    parse_block(&tokens, &mut position, 0)
}

fn parse_block(tokens: &[&[u8]], position: &mut usize, depth: usize) -> Option<Vec<PsOp>> {
    if depth > MAX_DEPTH {
        return None;
    }
    let mut program = Vec::new();
    let mut pending: Vec<Vec<PsOp>> = Vec::new();
    while let Some(token) = tokens.get(*position) {
        *position = position.saturating_add(1);
        match *token {
            b"}" => return Some(program),
            b"{" => pending.push(parse_block(tokens, position, depth.saturating_add(1))?),
            b"if" => {
                let then_block = pending.pop()?;
                program.push(PsOp::JumpUnless(then_block.len()));
                program.extend(then_block);
            }
            b"ifelse" => {
                let else_block = pending.pop()?;
                let then_block = pending.pop()?;
                program.push(PsOp::JumpUnless(then_block.len().saturating_add(1)));
                program.extend(then_block);
                program.push(PsOp::Jump(else_block.len()));
                program.extend(else_block);
            }
            word => {
                if let Some((_, code)) = PS_NAMES.iter().find(|(name, _)| *name == word) {
                    program.push(PsOp::Operator(*code));
                } else {
                    program.push(PsOp::Number(parse_decimal(word)?));
                }
            }
        }
        if program.len() > MAX_PROGRAM {
            return None;
        }
    }
    Some(program)
}

fn sin_degrees(degrees: f64) -> f64 {
    let turns = degrees / 360.0_f64;
    let reduced = (turns - (turns + 0.5).floor()) * 360.0_f64;
    let folded = if reduced > 90.0_f64 {
        180.0_f64 - reduced
    } else if reduced < -90.0_f64 {
        -180.0_f64 - reduced
    } else {
        reduced
    };
    let x = folded.to_radians();
    let square = x * x;
    x * (1.0
        + square
            * (-1.0 / 6.0
                + square
                    * (1.0 / 120.0
                        + square
                            * (-1.0 / 5040.0
                                + square * (1.0 / 362_880.0 - square / 39_916_800.0)))))
}

fn atan_unit(ratio: f64) -> f64 {
    let square = ratio * ratio;
    ratio
        * (0.999_977_26
            + square
                * (-0.332_623_47
                    + square
                        * (0.193_543_46
                            + square
                                * (-0.116_432_87
                                    + square * (0.052_653_32 - 0.011_721_2 * square)))))
}

fn atan2_degrees(numerator: f64, denominator: f64) -> f64 {
    if numerator == 0.0_f64 && denominator == 0.0_f64 {
        return 0.0;
    }
    let radians = if numerator.abs() <= denominator.abs() {
        let base = atan_unit(numerator / denominator);
        if denominator < 0.0_f64 {
            if numerator < 0.0_f64 {
                base - PI
            } else {
                base + PI
            }
        } else {
            base
        }
    } else {
        let base = atan_unit(denominator / numerator);
        if numerator > 0.0_f64 {
            FRAC_PI_2 - base
        } else {
            -FRAC_PI_2 - base
        }
    };
    radians.to_degrees()
}

fn pop_number(stack: &mut Vec<Value>) -> f64 {
    stack.pop().map_or(0.0, Value::number)
}

fn pop_int(stack: &mut Vec<Value>) -> i64 {
    f64_to_i64(pop_number(stack))
}

fn push(stack: &mut Vec<Value>, value: Value) {
    if stack.len() < MAX_STACK {
        stack.push(value);
    }
}

fn run_program(program: &[PsOp], stack: &mut Vec<Value>) {
    let mut pc = 0_usize;
    let mut steps = 0_usize;
    while let Some(op) = program.get(pc) {
        steps = steps.saturating_add(1);
        if steps > MAX_STEPS {
            return;
        }
        pc = pc.saturating_add(1);
        match *op {
            PsOp::Number(value) => push(stack, Value::real(value)),
            PsOp::Jump(len) => pc = pc.saturating_add(len),
            PsOp::JumpUnless(len) => {
                if !stack.pop().is_some_and(Value::is_true) {
                    pc = pc.saturating_add(len);
                }
            }
            PsOp::Operator(code) => run_operator(code, stack),
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one flat dispatch over the PostScript calculator operator set reads best as a single match"
)]
fn run_operator(code: u8, stack: &mut Vec<Value>) {
    match code {
        PS_ABS | PS_NEG | PS_CEILING | PS_FLOOR | PS_ROUND | PS_TRUNCATE | PS_SQRT | PS_SIN
        | PS_COS | PS_LN | PS_LOG | PS_CVR | PS_CVI | PS_EXP | PS_ATAN => {
            let value = pop_number(stack);
            let result = match code {
                PS_ABS => value.abs(),
                PS_NEG => -value,
                PS_CEILING => value.ceil(),
                PS_FLOOR => value.floor(),
                PS_ROUND => (value + 0.5).floor(),
                PS_TRUNCATE | PS_CVI => value.trunc(),
                PS_SQRT => value.max(0.0).sqrt(),
                PS_SIN => sin_degrees(value),
                PS_COS => sin_degrees(value + 90.0),
                PS_LN => value.ln(),
                PS_LOG => value.ln() / LN_10,
                PS_EXP => {
                    let base = pop_number(stack);
                    base.powf(value)
                }
                PS_ATAN => {
                    let numerator = pop_number(stack);
                    let angle = atan2_degrees(numerator, value);
                    if angle < 0.0_f64 {
                        angle + 360.0_f64
                    } else {
                        angle
                    }
                }
                _ => value,
            };
            push(
                stack,
                Value::real(if result.is_finite() { result } else { 0.0 }),
            );
        }
        PS_ADD | PS_SUB | PS_MUL | PS_DIV | PS_IDIV | PS_MOD => {
            let right = pop_number(stack);
            let left = pop_number(stack);
            let result = match code {
                PS_ADD => left + right,
                PS_SUB => left - right,
                PS_MUL => left * right,
                PS_DIV => {
                    if right == 0.0_f64 {
                        0.0_f64
                    } else {
                        left / right
                    }
                }
                PS_IDIV => {
                    if right.trunc() == 0.0_f64 {
                        0.0_f64
                    } else {
                        (left.trunc() / right.trunc()).trunc()
                    }
                }
                _ => {
                    if right.trunc() == 0.0_f64 {
                        0.0_f64
                    } else {
                        let divisor = right.trunc();
                        let dividend = left.trunc();
                        dividend - divisor * (dividend / divisor).trunc()
                    }
                }
            };
            push(stack, Value::real(result));
        }
        PS_EQ | PS_NE | PS_GT | PS_GE | PS_LT | PS_LE => {
            let right = pop_number(stack);
            let left = pop_number(stack);
            let result = match code {
                PS_EQ => (left - right).abs() < f64::EPSILON,
                PS_NE => (left - right).abs() >= f64::EPSILON,
                PS_GT => left > right,
                PS_GE => left >= right,
                PS_LT => left < right,
                _ => left <= right,
            };
            push(stack, Value::flag(result));
        }
        PS_AND | PS_OR | PS_XOR => {
            let right = stack.pop();
            let left = stack.pop();
            let a = f64_to_i64(left.map_or(0.0_f64, Value::number));
            let b = f64_to_i64(right.map_or(0.0_f64, Value::number));
            let combined = match code {
                PS_AND => a & b,
                PS_OR => a | b,
                _ => a ^ b,
            };
            let both_flags =
                left.is_some_and(|value| value.boolean) && right.is_some_and(|value| value.boolean);
            let value = if both_flags {
                Value::flag(combined != 0)
            } else {
                Value::real(i64_to_f64(combined))
            };
            push(stack, value);
        }
        PS_NOT => {
            let value = match stack.pop() {
                Some(top) if top.boolean => Value::flag(!top.is_true()),
                Some(top) => Value::real(i64_to_f64(!f64_to_i64(top.value))),
                None => Value::flag(true),
            };
            push(stack, value);
        }
        PS_BITSHIFT => {
            let shift = pop_int(stack).clamp(-31, 31);
            let value = pop_int(stack);
            let shifted = if shift >= 0 {
                value
                    .checked_shl(u32::try_from(shift).unwrap_or(0))
                    .unwrap_or(0)
            } else {
                value
                    .checked_shr(u32::try_from(shift.saturating_neg()).unwrap_or(0))
                    .unwrap_or(0)
            };
            push(stack, Value::real(i64_to_f64(shifted)));
        }
        PS_TRUE => push(stack, Value::flag(true)),
        PS_FALSE => push(stack, Value::flag(false)),
        PS_DUP => {
            if let Some(top) = stack.last().copied() {
                push(stack, top);
            }
        }
        PS_EXCH => {
            let len = stack.len();
            if len >= 2 {
                stack.swap(len.saturating_sub(1), len.saturating_sub(2));
            }
        }
        PS_POP => {
            let _: Option<Value> = stack.pop();
        }
        PS_COPY => {
            let count = usize::try_from(pop_int(stack))
                .unwrap_or(0)
                .min(stack.len());
            let start = stack.len().saturating_sub(count);
            let copied: Vec<Value> = stack.get(start..).unwrap_or_default().to_vec();
            for value in copied {
                push(stack, value);
            }
        }
        PS_INDEX => {
            let offset = usize::try_from(pop_int(stack)).unwrap_or(usize::MAX);
            let value = stack
                .len()
                .checked_sub(offset.saturating_add(1))
                .and_then(|position| stack.get(position))
                .copied()
                .unwrap_or(Value::real(0.0));
            push(stack, value);
        }
        PS_ROLL => {
            let shift = pop_int(stack);
            let count = usize::try_from(pop_int(stack))
                .unwrap_or(0)
                .min(stack.len());
            if count > 0 {
                let start = stack.len().saturating_sub(count);
                let modulus = i64::try_from(count).unwrap_or(1);
                let amount = usize::try_from(shift.rem_euclid(modulus)).unwrap_or(0);
                if let Some(window) = stack.get_mut(start..) {
                    window.rotate_right(amount);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::{Failure, Outcome};
    use crate::object::Stream;
    use alloc::rc::Rc;

    struct Bytes(Vec<u8>);

    impl Resolver for Bytes {
        fn resolve(&self, object: &Object) -> Outcome<Rc<Object>> {
            Ok(Rc::new(object.clone()))
        }

        fn stream_data(&self, stream: &Stream) -> Outcome<Vec<u8>> {
            self.0
                .get(stream.data.clone())
                .map(<[u8]>::to_vec)
                .ok_or_else(|| Failure::invalid("range"))
        }
    }

    fn dict(entries: Vec<(&str, Object)>) -> Dict {
        Dict {
            entries: entries
                .into_iter()
                .map(|(key, value)| (key.as_bytes().to_vec(), value))
                .collect(),
        }
    }

    fn array(values: &[f64]) -> Object {
        Object::Array(values.iter().map(|value| Object::Real(*value)).collect())
    }

    fn eval(function: &Function, inputs: &[f64]) -> Vec<f64> {
        let mut out = Vec::new();
        function.eval(inputs, &mut out);
        out
    }

    fn postscript(program: &str, domain: &[f64], range: &[f64]) -> Function {
        let resolver = Bytes(program.as_bytes().to_vec());
        let object = Object::Stream(Stream {
            data: 0..program.len(),
            dict: dict(vec![
                ("FunctionType", Object::Integer(4)),
                ("Domain", array(domain)),
                ("Range", array(range)),
            ]),
        });
        Function::parse(&resolver, &object).unwrap()
    }

    #[test]
    fn exponential_interpolates_and_raises() {
        let resolver = Bytes(Vec::new());
        let object = Object::Dict(dict(vec![
            ("FunctionType", Object::Integer(2)),
            ("Domain", array(&[0.0_f64, 1.0_f64])),
            ("C0", array(&[0.0_f64, 1.0_f64])),
            ("C1", array(&[1.0_f64, 0.0_f64])),
            ("N", Object::Integer(2)),
        ]));
        let function = Function::parse(&resolver, &object).unwrap();
        let out = eval(&function, &[0.5_f64]);
        assert!((out[0] - 0.25).abs() < 1e-9_f64);
        assert!((out[1] - 0.75).abs() < 1e-9_f64);
        assert_eq!(eval(&function, &[4.0_f64]), vec![1.0_f64, 0.0_f64]);
    }

    #[test]
    fn stitching_selects_subfunction_by_bounds() {
        let resolver = Bytes(Vec::new());
        let linear = |c0: f64, c1: f64| {
            Object::Dict(dict(vec![
                ("FunctionType", Object::Integer(2)),
                ("Domain", array(&[0.0_f64, 1.0_f64])),
                ("C0", array(&[c0])),
                ("C1", array(&[c1])),
                ("N", Object::Integer(1)),
            ]))
        };
        let object = Object::Dict(dict(vec![
            ("FunctionType", Object::Integer(3)),
            ("Domain", array(&[0.0_f64, 1.0_f64])),
            (
                "Functions",
                Object::Array(vec![linear(0.0_f64, 1.0_f64), linear(1.0_f64, 0.0_f64)]),
            ),
            ("Bounds", array(&[0.5_f64])),
            ("Encode", array(&[0.0_f64, 1.0_f64, 0.0_f64, 1.0_f64])),
        ]));
        let function = Function::parse(&resolver, &object).unwrap();
        assert!((eval(&function, &[0.25_f64])[0] - 0.5).abs() < 1e-9_f64);
        assert!((eval(&function, &[0.75_f64])[0] - 0.5).abs() < 1e-9_f64);
        assert!((eval(&function, &[1.0_f64])[0]).abs() < 1e-9_f64);
    }

    #[test]
    fn sampled_interpolates_linearly() {
        let data = vec![0_u8, 255, 0];
        let resolver = Bytes(data);
        let object = Object::Stream(Stream {
            data: 0..3,
            dict: dict(vec![
                ("FunctionType", Object::Integer(0)),
                ("Domain", array(&[0.0_f64, 1.0_f64])),
                ("Range", array(&[0.0_f64, 1.0_f64])),
                ("Size", Object::Array(vec![Object::Integer(3)])),
                ("BitsPerSample", Object::Integer(8)),
            ]),
        });
        let function = Function::parse(&resolver, &object).unwrap();
        assert!((eval(&function, &[0.25_f64])[0] - 0.5).abs() < 1e-6_f64);
        assert!((eval(&function, &[0.5_f64])[0] - 1.0).abs() < 1e-6_f64);
        assert!(eval(&function, &[1.0_f64])[0].abs() < 1e-6_f64);
    }

    #[test]
    fn postscript_calculator_runs_arithmetic_and_branches() {
        let function = postscript(
            "{ dup 0.5 gt { 1 exch sub } { 2 mul } ifelse }",
            &[0.0_f64, 1.0_f64],
            &[0.0_f64, 1.0_f64],
        );
        assert!((eval(&function, &[0.25_f64])[0] - 0.5).abs() < 1e-9_f64);
        assert!((eval(&function, &[0.75_f64])[0] - 0.25).abs() < 1e-9_f64);
        let rolled = postscript(
            "{ pop 1 2 3 3 1 roll }",
            &[0.0_f64, 1.0_f64],
            &[0.0_f64, 9.0_f64, 0.0_f64, 9.0_f64, 0.0_f64, 9.0_f64],
        );
        assert_eq!(eval(&rolled, &[0.0_f64]), vec![3.0_f64, 1.0_f64, 2.0_f64]);
        let logic = postscript(
            "{ pop true false or { 7 } if 2 3 bitshift 5 3 idiv 7 3 mod }",
            &[0.0_f64, 1.0_f64],
            &[
                0.0_f64, 99.0_f64, 0.0_f64, 99.0_f64, 0.0_f64, 99.0_f64, 0.0_f64, 99.0_f64,
            ],
        );
        assert_eq!(
            eval(&logic, &[0.0_f64]),
            vec![7.0_f64, 16.0_f64, 1.0_f64, 1.0_f64]
        );
        let trig = postscript(
            "{ pop 30 sin 60 cos 1 1 atan -1 -1 atan 100 log }",
            &[0.0_f64, 1.0_f64],
            &[
                -999.0_f64, 999.0_f64, -999.0_f64, 999.0_f64, -999.0_f64, 999.0_f64, -999.0_f64,
                999.0_f64, -999.0_f64, 999.0_f64,
            ],
        );
        let out = eval(&trig, &[0.0_f64]);
        for (value, expected) in out
            .iter()
            .zip([0.5_f64, 0.5_f64, 45.0_f64, 225.0_f64, 2.0_f64])
        {
            assert!((value - expected).abs() < 1e-3_f64, "{value} vs {expected}");
        }
        let cmyk = postscript(
            "{ 0 exch 0 exch 0 exch }",
            &[0.0_f64, 1.0_f64],
            &[
                0.0_f64, 1.0_f64, 0.0_f64, 1.0_f64, 0.0_f64, 1.0_f64, 0.0_f64, 1.0_f64,
            ],
        );
        assert_eq!(
            eval(&cmyk, &[0.8_f64]),
            vec![0.0_f64, 0.0_f64, 0.0_f64, 0.8_f64]
        );
    }

    #[test]
    fn postscript_is_bounded_on_hostile_programs() {
        let deep = format!("{}{}", "{ ".repeat(64), "} ".repeat(64));
        let resolver = Bytes(deep.into_bytes());
        let object = Object::Stream(Stream {
            data: 0..resolver.0.len(),
            dict: dict(vec![("FunctionType", Object::Integer(4))]),
        });
        assert!(Function::parse(&resolver, &object).is_none());
        let growing = postscript(
            "{ 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy 9 copy }",
            &[0.0_f64, 1.0_f64],
            &[0.0_f64, 1.0_f64],
        );
        assert_eq!(eval(&growing, &[0.0_f64]).len(), 1);
    }
}
