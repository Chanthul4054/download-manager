//! Message Stream Encryption (MSE/PE), the obfuscated handshake libtorrent, qBittorrent and most
//! other clients speak. Added to this vendored librqbit for OpenDM.
//!
//! A Diffie-Hellman exchange gives both sides a secret S; the torrent's info hash (SKEY) is proved
//! without being sent; the rest is RC4 (or, if both sides settle on it, plaintext after the
//! handshake). Spec: https://wiki.vuze.com/w/Message_Stream_Encryption

use std::io::IoSliceMut;
use std::pin::Pin;
use std::sync::LazyLock;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use anyhow::{Context as _, bail};
use librqbit_core::hash_id::Id20;
use num_bigint::BigUint;
use sha1w::ISha1;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

use crate::type_aliases::{BoxAsyncReadVectored, BoxAsyncWrite};
use crate::vectored_traits::AsyncReadVectored;

/// Which peer connections are encrypted, as in libtorrent's / qBittorrent's setting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EncryptionPolicy {
    /// Try encryption on outgoing connections (falling back to plaintext), accept both.
    #[default]
    Prefer,
    /// Encrypted (RC4) connections only.
    Require,
    /// Plaintext only; encrypted incoming connections are refused.
    Disable,
}

const PROVIDE_PLAIN: u32 = 0x01;
const PROVIDE_RC4: u32 = 0x02;
const MAX_PAD: usize = 512;
const PSTR: &[u8; 20] = b"\x13BitTorrent protocol";
/// The length of a whole BitTorrent handshake.
const HANDSHAKE_LEN: usize = 68;

static P: LazyLock<BigUint> = LazyLock::new(|| {
    BigUint::parse_bytes(
        b"FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A36210000000000090563",
        16,
    )
    .unwrap()
});

fn hash(parts: &[&[u8]]) -> [u8; 20] {
    let mut h = sha1w::Sha1::new();
    for p in parts {
        h.update(p);
    }
    h.finish()
}

fn be96(n: &BigUint) -> [u8; 96] {
    let b = n.to_bytes_be();
    let mut out = [0u8; 96];
    out[96 - b.len()..].copy_from_slice(&b);
    out
}

struct Dh {
    private: BigUint,
    public: [u8; 96],
}

impl Dh {
    fn new() -> Dh {
        let mut x = [0u8; 20];
        rand::fill(&mut x);
        let private = BigUint::from_bytes_be(&x);
        let public = be96(&BigUint::from(2u32).modpow(&private, &P));
        Dh { private, public }
    }

    fn secret(&self, their_public: &[u8]) -> [u8; 96] {
        be96(&BigUint::from_bytes_be(their_public).modpow(&self.private, &P))
    }
}

#[derive(Clone)]
pub(crate) struct Rc4 {
    s: [u8; 256],
    i: u8,
    j: u8,
}

impl Rc4 {
    fn new(key: &[u8]) -> Rc4 {
        let mut s = [0u8; 256];
        for (i, x) in s.iter_mut().enumerate() {
            *x = i as u8;
        }
        let mut j = 0u8;
        for i in 0..256 {
            j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
            s.swap(i, j as usize);
        }
        Rc4 { s, i: 0, j: 0 }
    }

    /// MSE drops the first 1024 bytes of each keystream.
    fn mse(key: &[u8]) -> Rc4 {
        let mut r = Rc4::new(key);
        r.apply(&mut [0u8; 1024]);
        r
    }

    fn apply(&mut self, buf: &mut [u8]) {
        for b in buf {
            self.i = self.i.wrapping_add(1);
            self.j = self.j.wrapping_add(self.s[self.i as usize]);
            self.s.swap(self.i as usize, self.j as usize);
            *b ^= self.s[self.s[self.i as usize].wrapping_add(self.s[self.j as usize]) as usize];
        }
    }
}

/// Reads bytes it already has (handshake leftovers) first, then the stream, decrypting if keyed.
struct MseRead {
    inner: BoxAsyncReadVectored,
    rc4: Option<Rc4>,
    prefix: Vec<u8>,
}

impl AsyncRead for MseRead {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if !this.prefix.is_empty() {
            let n = this.prefix.len().min(buf.remaining());
            buf.put_slice(&this.prefix[..n]);
            this.prefix.drain(..n);
            // Callers such as read_handshake expect a whole message from one read; add what is ready.
            if buf.remaining() > 0 && this.prefix.is_empty() {
                let before = buf.filled().len();
                if Pin::new(&mut this.inner).poll_read(cx, buf).is_ready() {
                    if let Some(r) = &mut this.rc4 {
                        r.apply(&mut buf.filled_mut()[before..]);
                    }
                }
            }
            return Poll::Ready(Ok(()));
        }
        let before = buf.filled().len();
        ready!(Pin::new(&mut this.inner).poll_read(cx, buf))?;
        if let Some(r) = &mut this.rc4 {
            r.apply(&mut buf.filled_mut()[before..]);
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncReadVectored for MseRead {
    fn poll_read_vectored(self: Pin<&mut Self>, cx: &mut Context<'_>, vec: &mut [IoSliceMut<'_>]) -> Poll<std::io::Result<usize>> {
        let Some(first) = vec.iter_mut().find(|s| !s.is_empty()) else { return Poll::Ready(Ok(0)) };
        let mut rb = ReadBuf::new(first);
        ready!(self.poll_read(cx, &mut rb))?;
        Poll::Ready(Ok(rb.filled().len()))
    }
}

/// Encrypts what is written, keeping ciphertext the stream has not taken yet.
struct MseWrite {
    inner: BoxAsyncWrite,
    rc4: Rc4,
    pending: Vec<u8>,
}

impl MseWrite {
    fn poll_pending(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        while !self.pending.is_empty() {
            let n = ready!(Pin::new(&mut self.inner).poll_write(cx, &self.pending))?;
            if n == 0 {
                return Poll::Ready(Err(std::io::ErrorKind::WriteZero.into()));
            }
            self.pending.drain(..n);
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for MseWrite {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        // `pending` is the ciphertext of the front of `buf`: a caller retries with the bytes it was
        // not told were written (as write_all does), so they are not encrypted twice.
        if this.pending.is_empty() {
            this.pending.extend_from_slice(buf);
            this.rc4.apply(&mut this.pending);
        }
        let n = ready!(Pin::new(&mut this.inner).poll_write(cx, &this.pending))?;
        this.pending.drain(..n);
        Poll::Ready(Ok(n))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        ready!(this.poll_pending(cx))?;
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        ready!(this.poll_pending(cx))?;
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

type Streams = (BoxAsyncReadVectored, BoxAsyncWrite);

fn wrap(read: BoxAsyncReadVectored, write: BoxAsyncWrite, keys: Option<(Rc4, Rc4)>, prefix: Vec<u8>) -> Streams {
    match keys {
        Some((dec, enc)) => (
            Box::new(MseRead { inner: read, rc4: Some(dec), prefix }),
            Box::new(MseWrite { inner: write, rc4: enc, pending: Vec::new() }),
        ),
        None if prefix.is_empty() => (read, write),
        None => (Box::new(MseRead { inner: read, rc4: None, prefix }), write),
    }
}

fn random_pad() -> Vec<u8> {
    let mut pad = vec![0u8; rand::random_range(0..=MAX_PAD)];
    rand::fill(&mut pad[..]);
    pad
}

/// Reads until `needle` has been seen (in `seen`, bytes already read, or after them), at most
/// `limit` bytes of padding in; returns what followed it.
async fn sync_on(read: &mut BoxAsyncReadVectored, mut seen: Vec<u8>, needle: &[u8], limit: usize) -> anyhow::Result<Vec<u8>> {
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(at) = seen.windows(needle.len()).position(|w| w == needle) {
            return Ok(seen.split_off(at + needle.len()));
        }
        if seen.len() > limit + needle.len() {
            bail!("peer did not send the expected MSE handshake");
        }
        let n = read.read(&mut chunk).await?;
        if n == 0 {
            bail!("peer closed the connection during the MSE handshake");
        }
        seen.extend_from_slice(&chunk[..n]);
    }
}

/// Reads exactly `n` bytes, taking leftovers from `have` first.
async fn take(read: &mut BoxAsyncReadVectored, have: &mut Vec<u8>, n: usize) -> anyhow::Result<Vec<u8>> {
    while have.len() < n {
        let mut chunk = [0u8; 1024];
        let got = read.read(&mut chunk).await?;
        if got == 0 {
            bail!("peer closed the connection during the MSE handshake");
        }
        have.extend_from_slice(&chunk[..got]);
    }
    let rest = have.split_off(n);
    Ok(std::mem::replace(have, rest))
}

fn be16(b: &[u8]) -> usize {
    u16::from_be_bytes([b[0], b[1]]) as usize
}

/// Runs the handshake as the connecting side. The BitTorrent handshake follows on the returned streams.
pub(crate) async fn initiate(mut read: BoxAsyncReadVectored, mut write: BoxAsyncWrite, info_hash: Id20, require_rc4: bool, timeout: Duration) -> anyhow::Result<Streams> {
    tokio::time::timeout(timeout, async move {
        let dh = Dh::new();
        let mut first = dh.public.to_vec();
        first.extend(random_pad());
        write.write_all(&first).await?;
        let mut have = Vec::new();
        let yb = take(&mut read, &mut have, 96).await?;
        let s = dh.secret(&yb);
        let skey = &info_hash.0[..];
        let mut enc = Rc4::mse(&hash(&[b"keyA", &s, skey]));
        let mut dec = Rc4::mse(&hash(&[b"keyB", &s, skey]));

        let mut msg = hash(&[b"req1", &s]).to_vec();
        let (r2, r3) = (hash(&[b"req2", skey]), hash(&[b"req3", &s]));
        msg.extend(r2.iter().zip(r3).map(|(a, b)| a ^ b));
        let provide = if require_rc4 { PROVIDE_RC4 } else { PROVIDE_RC4 | PROVIDE_PLAIN };
        let mut tail = [0u8; 8].to_vec(); // VC
        tail.extend(provide.to_be_bytes());
        tail.extend(0u16.to_be_bytes()); // no PadC
        tail.extend(0u16.to_be_bytes()); // no initial payload: the BitTorrent handshake follows
        enc.apply(&mut tail);
        msg.extend(tail);
        write.write_all(&msg).await?;

        // The answer starts with VC encrypted: find it after the peer's random padding.
        let mut vc = [0u8; 8];
        dec.clone().apply(&mut vc);
        let mut have = sync_on(&mut read, have, &vc, MAX_PAD).await?;
        dec.apply(&mut [0u8; 8]);
        let mut head = take(&mut read, &mut have, 6).await?;
        dec.apply(&mut head);
        let select = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
        let mut pad = take(&mut read, &mut have, be16(&head[4..])).await?;
        dec.apply(&mut pad);
        match select {
            PROVIDE_RC4 => {
                dec.apply(&mut have);
                Ok(wrap(read, write, Some((dec, enc)), have))
            }
            PROVIDE_PLAIN if !require_rc4 => Ok(wrap(read, write, None, have)),
            _ => bail!("peer chose an unsupported MSE crypto method {select:#x}"),
        }
    })
    .await
    .context("MSE handshake timed out")?
}

/// Takes an incoming connection: a plain BitTorrent handshake passes through (unless encryption is
/// required), anything else is answered as MSE for one of `info_hashes`.
pub(crate) async fn accept(mut read: BoxAsyncReadVectored, mut write: BoxAsyncWrite, policy: EncryptionPolicy, info_hashes: &[Id20], timeout: Duration) -> anyhow::Result<Streams> {
    tokio::time::timeout(timeout, async move {
        let mut have = Vec::new();
        let start = take(&mut read, &mut have, PSTR.len()).await?;
        if start == PSTR {
            if policy == EncryptionPolicy::Require {
                bail!("refusing an unencrypted peer (encryption is required)");
            }
            // Hand the whole handshake to the caller in one read, as it was before.
            let rest = take(&mut read, &mut have, HANDSHAKE_LEN - PSTR.len()).await?;
            return Ok(wrap(read, write, None, [start, rest, have].concat()));
        }
        if policy == EncryptionPolicy::Disable {
            bail!("refusing an encrypted peer (encryption is disabled)");
        }
        let ya = [start, take(&mut read, &mut have, 96 - PSTR.len()).await?].concat();
        let dh = Dh::new();
        let mut first = dh.public.to_vec();
        first.extend(random_pad());
        write.write_all(&first).await?;
        let s = dh.secret(&ya);

        let mut have = sync_on(&mut read, have, &hash(&[b"req1", &s]), MAX_PAD).await?;
        let proof = take(&mut read, &mut have, 20).await?;
        let r3 = hash(&[b"req3", &s]);
        let skey = info_hashes
            .iter()
            .find(|ih| hash(&[b"req2", &ih.0]).iter().zip(r3).map(|(a, b)| a ^ b).eq(proof.iter().copied()))
            .context("encrypted peer asked for a torrent we do not have")?;
        let mut dec = Rc4::mse(&hash(&[b"keyA", &s, &skey.0]));
        let mut enc = Rc4::mse(&hash(&[b"keyB", &s, &skey.0]));

        let mut head = take(&mut read, &mut have, 14).await?;
        dec.apply(&mut head);
        if head[..8] != [0u8; 8] {
            bail!("bad MSE verification constant");
        }
        let provide = u32::from_be_bytes([head[8], head[9], head[10], head[11]]);
        let mut pad = take(&mut read, &mut have, be16(&head[12..])).await?;
        dec.apply(&mut pad);
        let mut ia_len = take(&mut read, &mut have, 2).await?;
        dec.apply(&mut ia_len);
        let mut ia = take(&mut read, &mut have, be16(&ia_len)).await?;
        dec.apply(&mut ia);

        let select = if provide & PROVIDE_RC4 != 0 {
            PROVIDE_RC4
        } else if provide & PROVIDE_PLAIN != 0 && policy != EncryptionPolicy::Require {
            PROVIDE_PLAIN
        } else {
            bail!("encrypted peer offers no crypto method we accept ({provide:#x})");
        };
        let mut answer = [0u8; 8].to_vec();
        answer.extend(select.to_be_bytes());
        answer.extend(0u16.to_be_bytes()); // no PadD
        enc.apply(&mut answer);
        write.write_all(&answer).await?;
        if select == PROVIDE_RC4 {
            dec.apply(&mut have);
            Ok(wrap(read, write, Some((dec, enc)), [ia, have].concat()))
        } else {
            Ok(wrap(read, write, None, [ia, have].concat()))
        }
    })
    .await
    .context("MSE handshake timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectored_traits::AsyncReadVectoredIntoCompat;

    #[test]
    fn rc4_matches_the_published_test_vector() {
        let mut b = *b"Plaintext";
        Rc4::new(b"Key").apply(&mut b);
        assert_eq!(b, [0xBB, 0xF3, 0x16, 0xE8, 0xD9, 0x40, 0xAF, 0x0A, 0xD3]);
    }

    fn pipe() -> (Streams, Streams) {
        pipe_of(1 << 16)
    }

    fn pipe_of(cap: usize) -> (Streams, Streams) {
        let (a, b) = tokio::io::duplex(cap);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        ((Box::new(ar.into_vectored_compat()), Box::new(aw)), (Box::new(br.into_vectored_compat()), Box::new(bw)))
    }

    async fn talk(policy_in: EncryptionPolicy, require_out: bool, plain_out: bool) -> anyhow::Result<()> {
        let ih = Id20::new([7u8; 20]);
        let ((ar, aw), (br, bw)) = pipe();
        let t = Duration::from_secs(5);
        let out = async move {
            let (mut r, mut w) = if plain_out { (ar, aw) } else { initiate(ar, aw, ih, require_out, t).await? };
            let mut hs = PSTR.to_vec();
            hs.extend([0u8; HANDSHAKE_LEN - 20]);
            w.write_all(&hs).await?;
            w.write_all(b"ping").await?;
            w.flush().await?;
            let mut pong = [0u8; 4];
            r.read_exact(&mut pong).await?;
            assert_eq!(&pong, b"pong");
            anyhow::Ok(())
        };
        let inc = async move {
            let (mut r, mut w) = accept(br, bw, policy_in, &[Id20::new([1u8; 20]), ih], t).await?;
            // The handshake arrives in one read, as librqbit's read_handshake expects.
            let mut hs = [0u8; 128];
            let n = r.read(&mut hs).await?;
            assert!(n >= HANDSHAKE_LEN && hs.starts_with(PSTR), "{n}");
            let mut ping = vec![0u8; 4 - (n - HANDSHAKE_LEN)];
            r.read_exact(&mut ping).await?;
            assert_eq!([&hs[HANDSHAKE_LEN..n], &ping[..]].concat(), b"ping");
            w.write_all(b"pong").await?;
            w.flush().await?;
            anyhow::Ok(())
        };
        let (a, b) = tokio::join!(out, inc);
        a.and(b)
    }

    #[tokio::test]
    async fn encrypted_and_plain_peers_meet_according_to_policy() {
        talk(EncryptionPolicy::Prefer, false, false).await.unwrap();
        talk(EncryptionPolicy::Require, true, false).await.unwrap();
        talk(EncryptionPolicy::Prefer, false, true).await.unwrap();
        assert!(talk(EncryptionPolicy::Require, false, true).await.is_err());
        assert!(talk(EncryptionPolicy::Disable, false, false).await.is_err());
    }

    // uTP takes writes in parts; everything written must arrive without a flush.
    #[tokio::test]
    async fn partial_writes_all_arrive_without_flush() {
        let ih = Id20::new([7u8; 20]);
        let ((ar, aw), (br, bw)) = pipe_of(2048);
        let t = Duration::from_secs(5);
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let sent = data.clone();
        let out = async move {
            let (_r, mut w) = initiate(ar, aw, ih, true, t).await?;
            let mut hs = PSTR.to_vec();
            hs.extend([0u8; HANDSHAKE_LEN - 20]);
            w.write_all(&hs).await?;
            w.write_all(&sent).await?;
            std::future::pending::<()>().await;
            anyhow::Ok(())
        };
        let inc = async move {
            let (mut r, _w) = accept(br, bw, EncryptionPolicy::Require, &[ih], t).await?;
            let mut got = vec![0u8; HANDSHAKE_LEN + data.len()];
            r.read_exact(&mut got).await?;
            assert_eq!(&got[HANDSHAKE_LEN..], &data[..]);
            anyhow::Ok(())
        };
        let both = async { tokio::select! { r = out => r, r = inc => r } };
        tokio::time::timeout(Duration::from_secs(10), both).await.expect("data stuck in the writer").unwrap();
    }
}
