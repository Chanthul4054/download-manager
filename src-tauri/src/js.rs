//! Small helpers that reproduce JavaScript value semantics on `serde_json::Value`, so code ported
//! from the Electron version keeps its exact behavior (`Number(x) || 8`, truthiness, `x ?? y`).

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// `Number(v)`: NaN for objects, arrays and unparsable strings; 0 for null/false/"".
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as u8 as f64,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// `Number(v) || fallback`.
pub fn num_or(v: &Value, fallback: f64) -> f64 {
    let n = num(v);
    if n == 0.0 || n.is_nan() {
        fallback
    } else {
        n
    }
}

/// JavaScript truthiness. A missing key reads as `Value::Null` here, like `undefined`.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(v)` for the values the app stores (strings, numbers, booleans).
pub fn str_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => fmt_num(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// `String(n)` for a JS number.
pub fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// `v` as a string, or "" when it is not a string (the `x || ''` idiom on string fields).
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// `obj[key]` where a missing object or key reads as null.
pub fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}

/// Mutable `obj[key]`, creating the key (and turning `obj` into an object) when needed.
pub fn get_mut<'a>(v: &'a mut Value, key: &str) -> &'a mut Value {
    if !v.is_object() {
        *v = Value::Object(Map::new());
    }
    v.as_object_mut().unwrap().entry(key.to_string()).or_insert(Value::Null)
}

/// JS `parseInt(s, 10)`: the leading integer, or NaN.
pub fn parse_int(s: &str) -> f64 {
    let t = s.trim_start();
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        f64::NAN
    } else {
        sign * digits.parse::<f64>().unwrap_or(f64::NAN)
    }
}

/// JS `parseFloat(s)`: the leading decimal number, or NaN.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut seen_digit = false;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        seen_digit = true;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            seen_digit = true;
        }
    }
    if !seen_digit {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            i = j;
        }
    }
    t[..i].parse::<f64>().unwrap_or(f64::NAN)
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ---- lenient serde field readers -----------------------------------------------------------------
// The renderer sends whatever its form fields hold; JS stored those as-is. These accept any JSON
// and coerce it, so a stray string or null never makes a whole document fail to load.

pub fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(str_of(&Value::deserialize(d)?))
}

pub fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => None,
        v => Some(str_of(&v)),
    })
}

pub fn de_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(truthy(&Value::deserialize(d)?))
}

pub fn de_opt_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => None,
        v => Some(truthy(&v)),
    })
}

pub fn de_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let n = num(&Value::deserialize(d)?);
    Ok(if n.is_nan() { 0.0 } else { n })
}

pub fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => None,
        v => {
            let n = num(&v);
            if n.is_nan() {
                None
            } else {
                Some(n)
            }
        }
    })
}

pub fn de_u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let n = num(&Value::deserialize(d)?);
    Ok(if n.is_finite() && n > 0.0 { n as u64 } else { 0 })
}

pub fn de_opt_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Null => None,
        v => {
            let n = num(&v);
            if n.is_finite() && n >= 0.0 {
                Some(n as u64)
            } else {
                None
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coercion_matches_javascript() {
        assert_eq!(num(&json!("12")), 12.0);
        assert!(num(&json!("x")).is_nan());
        assert_eq!(num(&Value::Null), 0.0);
        assert_eq!(num_or(&json!(0), 8.0), 8.0);
        assert_eq!(num_or(&json!("abc"), 8.0), 8.0);
        assert!(!truthy(&json!("")));
        assert!(truthy(&json!([])));
        assert_eq!(fmt_num(3.0), "3");
        assert_eq!(fmt_num(2.5), "2.5");
    }
}
