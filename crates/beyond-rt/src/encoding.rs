//! UTF-8 for TextEncoder and TextDecoder, where the engine's own conversions
//! differ from the Encoding standard: the engine writes a lone surrogate as
//! its WTF-8 bytes rather than U+FFFD, and reads invalid UTF-8 its own way.
//! Rust's validation is fast, and its lossy decoding replaces each maximal
//! invalid subpart with U+FFFD, as the standard's decoder does.

use std::slice;

fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { slice::from_raw_parts(p, len) } }
}

/// Replaces the lone surrogates in the engine's UTF-8 of a string (WTF-8:
/// ED A0..BF xx) with U+FFFD (EF BF BD), in place.
///
/// # Safety
/// `p[..len]` is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_rt_wtf8_fix(p: *mut u8, len: usize) {
    if len == 0 {
        return;
    }
    let b = unsafe { slice::from_raw_parts_mut(p, len) };
    let mut i = 0;
    while let Some(k) = b[i..].iter().position(|&x| x == 0xED) {
        let j = i + k;
        if j + 2 < len && b[j + 1] >= 0xA0 {
            b[j..j + 3].copy_from_slice(&[0xEF, 0xBF, 0xBD]);
        }
        i = j + 1;
    }
}

/// The length of the valid UTF-8 that `p[..len]` starts with. `*error_len`
/// is set to the length of the invalid sequence after it, or 0 when there
/// is none or the bytes end in the middle of a sequence.
///
/// # Safety
/// `p[..len]` is readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_rt_utf8_valid(p: *const u8, len: usize, error_len: *mut usize) -> usize {
    let (valid, err) = match std::str::from_utf8(bytes(p, len)) {
        Ok(_) => (len, 0),
        Err(e) => (e.valid_up_to(), e.error_len().unwrap_or(0)),
    };
    unsafe { *error_len = err };
    valid
}

/// Decodes `p[..len]` as the Encoding standard's UTF-8 decoder does (each
/// maximal invalid subpart becomes U+FFFD) into `out`, which has room for
/// `3 * len` bytes; returns the length written.
///
/// # Safety
/// `p[..len]` is readable, `out[..3 * len]` writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_rt_utf8_lossy(p: *const u8, len: usize, out: *mut u8) -> usize {
    let mut n = 0;
    for chunk in bytes(p, len).utf8_chunks() {
        let v = chunk.valid().as_bytes();
        unsafe { std::ptr::copy_nonoverlapping(v.as_ptr(), out.add(n), v.len()) };
        n += v.len();
        if !chunk.invalid().is_empty() {
            unsafe { std::ptr::copy_nonoverlapping([0xEF, 0xBF, 0xBD].as_ptr(), out.add(n), 3) };
            n += 3;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lossy(b: &[u8]) -> Vec<u8> {
        let mut out = vec![0; 3 * b.len()];
        let n = unsafe { beyond_rt_utf8_lossy(b.as_ptr(), b.len(), out.as_mut_ptr()) };
        out.truncate(n);
        out
    }

    #[test]
    fn decode() {
        assert_eq!(lossy(b"a\xffb"), "a\u{FFFD}b".as_bytes());
        assert_eq!(lossy(b"\xf0\x9f\x98"), "\u{FFFD}".as_bytes());
        assert_eq!(lossy(b"\xed\xa0\x80a"), "\u{FFFD}\u{FFFD}\u{FFFD}a".as_bytes());
        assert_eq!(lossy(b"\xe2\x82\x41"), "\u{FFFD}A".as_bytes());
        let mut err = 9;
        assert_eq!(unsafe { beyond_rt_utf8_valid(b"ab\xe2\x82".as_ptr(), 4, &mut err) }, 2);
        assert_eq!(err, 0);
        assert_eq!(unsafe { beyond_rt_utf8_valid(b"ab\xffc".as_ptr(), 4, &mut err) }, 2);
        assert_eq!(err, 1);
    }

    #[test]
    fn surrogates() {
        let mut b = b"a\xed\xa0\x80b\xed\x9f\xbf".to_vec();
        unsafe { beyond_rt_wtf8_fix(b.as_mut_ptr(), b.len()) };
        assert_eq!(b, "a\u{FFFD}b\u{D7FF}".as_bytes());
    }
}
