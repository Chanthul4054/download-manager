//! A download list entry. Serialized exactly as the Electron version wrote `downloads.json`, so an
//! existing download list loads unchanged. A muxed download's parts are items too: each part is
//! downloaded by its own HttpDownload, which reads and writes the same fields.

use std::cell::RefCell;
use std::rc::Rc;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::js::*;

/// `end` of an open-ended segment (JS `Infinity`, stored as null).
pub const INF: u64 = u64::MAX;

#[derive(Debug, Clone, PartialEq)]
pub struct Seg {
    pub start: u64,
    pub end: u64,
    pub pos: u64,
}

pub type SegRef = Rc<RefCell<Seg>>;

pub fn seg(start: u64, end: u64, pos: u64) -> SegRef {
    Rc::new(RefCell::new(Seg { start, end, pos }))
}

impl Serialize for Seg {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Map::new();
        m.insert("start".into(), self.start.into());
        m.insert("end".into(), if self.end == INF { Value::Null } else { self.end.into() });
        m.insert("pos".into(), self.pos.into());
        Value::Object(m).serialize(s)
    }
}

impl<'de> Deserialize<'de> for Seg {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        let n = |k: &str| {
            let x = num(get(&v, k));
            if x.is_finite() && x >= 0.0 {
                Some(x as u64)
            } else {
                None
            }
        };
        Ok(Seg { start: n("start").unwrap_or(0), end: n("end").unwrap_or(INF), pos: n("pos").unwrap_or(0) })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Auth {
    #[serde(default, deserialize_with = "de_string")]
    pub user: String,
    #[serde(default, deserialize_with = "de_string")]
    pub pass: String,
}

impl Auth {
    /// `x && x.user ? x : null`
    pub fn from_value(v: &Value) -> Option<Auth> {
        if !truthy(get(v, "user")) {
            return None;
        }
        serde_json::from_value(v.clone()).ok()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtraFile {
    #[serde(default, deserialize_with = "de_string")]
    pub temp: String,
    #[serde(default, deserialize_with = "de_string")]
    pub name: String,
}

pub type ItemRef = Rc<RefCell<Item>>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub id: String,
    #[serde(default, deserialize_with = "de_string")]
    pub url: String,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<ItemRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ytdlp: Option<Value>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub range_mode: Option<String>,
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub file_name: String,
    #[serde(default, deserialize_with = "de_bool", skip_serializing_if = "is_false")]
    pub name_locked: bool,
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub save_dir: String,
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub category: String,
    #[serde(default, deserialize_with = "de_string")]
    pub description: String,
    #[serde(default, deserialize_with = "de_string")]
    pub referer: String,
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub parent_page: String,
    #[serde(default, deserialize_with = "de_string")]
    pub cookies: String,
    #[serde(default, deserialize_with = "de_string")]
    pub user_agent: String,
    #[serde(default, deserialize_with = "de_auth")]
    pub auth: Option<Auth>,
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, deserialize_with = "de_opt_u64")]
    pub size: Option<u64>,
    #[serde(default, deserialize_with = "de_u64")]
    pub downloaded: u64,
    #[serde(default, deserialize_with = "de_opt_bool")]
    pub resumable: Option<bool>,
    #[serde(default, deserialize_with = "de_f64", skip_serializing_if = "is_zero")]
    pub added: f64,
    #[serde(default, deserialize_with = "de_opt_f64", skip_serializing_if = "Option::is_none")]
    pub last_try: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub max_connections: f64,
    #[serde(default, deserialize_with = "de_f64", rename = "speedLimitKB")]
    pub speed_limit_kb: f64,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub on_complete: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hls: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queues: Option<Value>,
    #[serde(default, deserialize_with = "de_bool", skip_serializing_if = "is_false")]
    pub overwrite: bool,
    #[serde(default, deserialize_with = "de_string", skip_serializing_if = "String::is_empty")]
    pub temp_path: String,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, deserialize_with = "de_opt_f64", skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_f64", skip_serializing_if = "Option::is_none")]
    pub eta: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_f64", skip_serializing_if = "Option::is_none")]
    pub estimated_size: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub pending_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<Value>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    #[serde(default, deserialize_with = "de_opt_f64", skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<SegRef>>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_files: Option<Vec<ExtraFile>>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_headers: Option<Map<String, Value>>,
    // Fields of a muxed download's part.
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string", skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(default, deserialize_with = "de_bool", skip_serializing_if = "is_false")]
    pub done: bool,
    /// Anything else an older or newer version stored, kept as-is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &f64) -> bool {
    *n == 0.0
}

fn de_auth<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Auth>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(if v.is_object() { serde_json::from_value(v).ok() } else { None })
}

impl Item {
    pub fn kind(&self) -> &str {
        self.kind.as_deref().unwrap_or("")
    }

    /// Bytes received across all segments (or the plain counter for a download without them).
    pub fn segments_downloaded(&self) -> u64 {
        match &self.segments {
            None => self.downloaded,
            Some(s) => s.iter().map(|x| {
                let x = x.borrow();
                x.pos.saturating_sub(x.start)
            }).sum(),
        }
    }

    /// `[[start, end|null, pos]]` for the progress map.
    pub fn segment_triples(&self) -> Value {
        Value::Array(
            self.segments
                .iter()
                .flatten()
                .map(|s| {
                    let s = s.borrow();
                    serde_json::json!([s.start, if s.end == INF { Value::Null } else { s.end.into() }, s.pos])
                })
                .collect(),
        )
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}
