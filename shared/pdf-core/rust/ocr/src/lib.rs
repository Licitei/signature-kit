mod abi;
mod lexicon;
mod postprocess;
mod recognize;

#[used]
static KEEP_CORRECT: fn(&mut [recognize::Word]) = postprocess::correct;

#[used]
static KEEP_CORRECT_LINES: fn(&mut [Vec<recognize::Word>]) -> Vec<postprocess::DehyphenHint> =
    postprocess::correct_lines;
