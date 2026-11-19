use crate::recognize::Word;

pub(crate) fn correct(words: &mut [Word]) {
    for word in words {
        word.alternatives.clear();
    }
}
