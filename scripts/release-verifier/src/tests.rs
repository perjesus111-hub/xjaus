use super::*;
#[test]
fn production_fails_closed() {
    assert!(crate::production_verify().is_err());
    let root = std::fs::File::open(".").unwrap();
    let called = std::cell::Cell::new(false);
    assert!(crate::verify_release(&root, b"", b"", |_| called.set(true)).is_err());
    assert!(!called.get());
}
use ring::signature::{Ed25519KeyPair, KeyPair};
#[test]
fn temporary_key_reaches_the_real_verification_engine() {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
    let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 1,
        digest: [0; 32],
    });
    let m = encode(COMMIT, &records);
    let root = std::fs::File::open(".").unwrap();
    let called = std::cell::Cell::new(false);
    let err = implementation::verify_policy(
        &root,
        &m,
        key.sign(&m).as_ref(),
        key.public_key().as_ref().try_into().unwrap(),
        &[0; 32],
        || {},
        |_| called.set(true),
    )
    .unwrap_err();
    assert!(err.to_string().contains("directory entries"));
    assert!(!called.get());
}
#[test]
fn canonical_authentication_binds_all_fields() {
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 10 + i as u64,
        digest: [i as u8; 32],
    });
    let m = encode(COMMIT, &records);
    let sig = key.sign(&m);
    assert!(authenticate(&m, sig.as_ref(), key.public_key().as_ref(), COMMIT).is_ok());
    for i in 0..m.len() {
        let mut bad = m.clone();
        bad[i] ^= 1;
        assert!(authenticate(&bad, sig.as_ref(), key.public_key().as_ref(), COMMIT).is_err());
    }
    let mut extra = m.clone();
    extra.push(0);
    assert!(
        authenticate(
            &extra,
            key.sign(&extra).as_ref(),
            key.public_key().as_ref(),
            COMMIT
        )
        .is_err()
    );
    assert!(
        authenticate(
            &m,
            sig.as_ref(),
            key.public_key().as_ref(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        .is_err()
    );
    let wrong = Ed25519KeyPair::from_seed_unchecked(&[43; 32]).unwrap();
    assert!(authenticate(&m, sig.as_ref(), wrong.public_key().as_ref(), COMMIT).is_err());
}
#[test]
fn rejects_signed_noncanonical_records() {
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 16,
        digest: [i as u8; 32],
    });
    for name in [
        NAMES[0],
        "../XJAUS-1.2.3-linux-x86_64.rpm",
        "linux/XJAUS-1.2.4-linux-x86_64.rpm",
    ] {
        let mut bad = records.clone();
        bad[1].name = name;
        let m = encode(COMMIT, &bad);
        assert!(
            authenticate(&m, key.sign(&m).as_ref(), key.public_key().as_ref(), COMMIT).is_err()
        );
    }
    let mut bad = records;
    bad[1].size = 0;
    let m = encode(COMMIT, &bad);
    assert!(authenticate(&m, key.sign(&m).as_ref(), key.public_key().as_ref(), COMMIT).is_err());
}
#[test]
fn rejects_signed_wrong_commit_even_when_caller_supplies_it() {
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 1,
        digest: [0; 32],
    });
    let wrong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let m = encode(wrong, &records);
    assert!(authenticate(&m, key.sign(&m).as_ref(), key.public_key().as_ref(), wrong).is_err());
}

#[test]
fn directory_and_authentication_failures_never_call_consumer() {
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, File},
        os::unix::fs::symlink,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::path::PathBuf::from(std::env::var_os("TMPDIR").unwrap()).join(format!(
        "verifier-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    fs::create_dir(dir.join("linux")).unwrap();
    fs::create_dir(dir.join("win")).unwrap();
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 3,
        digest: Sha256::digest(b"abc").into(),
    });
    for n in NAMES {
        fs::write(dir.join(n), b"abc").unwrap();
    }
    let root = File::open(&dir).unwrap();
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let original = encode(COMMIT, &records);
    let check = |m: &[u8], sig: &[u8], expected: &str| {
        let called = std::cell::Cell::new(false);
        let e = verify(&root, m, sig, |_| called.set(true)).unwrap_err();
        assert!(
            e.to_string().contains(expected),
            "{e} did not contain {expected}"
        );
        assert!(!called.get());
    };
    let sig = key.sign(&original);
    let wrong = Ed25519KeyPair::from_seed_unchecked(&[43; 32]).unwrap();
    check(&original, wrong.sign(&original).as_ref(), "signature");
    let mut m = original.clone();
    m[27] ^= 1;
    check(&m, key.sign(&m).as_ref(), "header");
    let mut m = encode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &records);
    check(&m, key.sign(&m).as_ref(), "header");
    let mut bad = records.clone();
    bad[1].name = NAMES[0];
    m = encode(COMMIT, &bad);
    check(&m, key.sign(&m).as_ref(), "name");
    bad[1].name = "../unsafe";
    m = encode(COMMIT, &bad);
    check(&m, key.sign(&m).as_ref(), "name");
    m = original[..original.len() - 1].to_vec();
    check(&m, key.sign(&m).as_ref(), "truncated");
    fs::write(dir.join("linux/unknown"), b"x").unwrap();
    check(&original, sig.as_ref(), "directory entries");
    fs::remove_file(dir.join("linux/unknown")).unwrap();
    fs::create_dir(dir.join("win/nested")).unwrap();
    fs::write(dir.join("win/nested/unknown"), b"x").unwrap();
    check(&original, sig.as_ref(), "directory entries");
    fs::remove_dir_all(dir.join("win/nested")).unwrap();
    fs::remove_file(dir.join(NAMES[4])).unwrap();
    check(&original, sig.as_ref(), "directory entries");
    symlink("/dev/null", dir.join(NAMES[4])).unwrap();
    check(&original, sig.as_ref(), "Too many levels");
    fs::remove_file(dir.join(NAMES[4])).unwrap();
    fs::write(dir.join(NAMES[4]), b"abc").unwrap();
    fs::write(dir.join(NAMES[0]), b"abcd").unwrap();
    check(&original, sig.as_ref(), "size");
    fs::write(dir.join(NAMES[0]), b"xyz").unwrap();
    check(&original, sig.as_ref(), "digest");
    fs::write(dir.join(NAMES[0]), b"abc").unwrap();
    check(&original, sig.as_ref(), "failed to fill whole buffer");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn seal_creates_immutable_memfd() {
    use std::os::fd::AsRawFd;
    let file = seal(&b"abc"[..], 3).unwrap();
    let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    let required = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    assert_eq!(seals & required, required);
    assert!(seal(&b"ab"[..], 3).is_err());
}

// Explicitly opt in: copies ~800 MiB of real candidates into private scratch.
#[test]
#[ignore = "requires local release candidates and substantial scratch space"]
fn real_candidates_end_to_end() {
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, File, OpenOptions},
        io::{Read, Seek, SeekFrom, Write},
        os::{
            fd::AsRawFd,
            unix::fs::{DirBuilderExt, symlink},
        },
        path::PathBuf,
    };
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let scratch = PathBuf::from(std::env::var_os("TMPDIR").expect("private TMPDIR required"))
        .join(format!("real-verifier-{}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&scratch).unwrap();
    let scratch = Scratch(scratch);
    fs::create_dir(scratch.0.join("linux")).unwrap();
    fs::create_dir(scratch.0.join("win")).unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../release");
    let mut records = Vec::new();
    for name in NAMES {
        let dest = scratch.0.join(name);
        fs::copy(source.join(name), &dest).unwrap();
        let mut file = File::open(&dest).unwrap();
        let size = file.metadata().unwrap().len();
        let mut hash = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        records.push(Record {
            name,
            size,
            digest: hash.finalize().into(),
        });
    }
    let records: [Record; 5] = records.try_into().ok().unwrap();
    // Ephemeral test-only signing key, never a production trust anchor.
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let public_key: [u8; 32] = key.public_key().as_ref().try_into().unwrap();
    let manifest = encode(COMMIT, &records);
    let sig = key.sign(&manifest);
    let root = File::open(&scratch.0).unwrap();
    let calls = std::cell::Cell::new(0);
    implementation::verify_policy(
        &root,
        &manifest,
        sig.as_ref(),
        &public_key,
        &implementation::REFERENCE,
        || {},
        |files| {
            calls.set(calls.get() + 1);
            assert_eq!(files.len(), 5);
            // Substitute the source pathname after verification, before consuming FDs.
            let path = scratch.0.join(NAMES[0]);
            fs::remove_file(&path).unwrap();
            fs::write(&path, b"substituted").unwrap();
            for (file, record) in files.iter().zip(&records) {
                let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
                let required = libc::F_SEAL_WRITE
                    | libc::F_SEAL_GROW
                    | libc::F_SEAL_SHRINK
                    | libc::F_SEAL_SEAL;
                assert!(seals >= 0 && seals & required == required);
                assert_eq!(file.metadata().unwrap().len(), record.size);
                let mut f = file.try_clone().unwrap();
                f.seek(SeekFrom::Start(0)).unwrap();
                let mut hash = Sha256::new();
                let mut buf = [0u8; 65536];
                loop {
                    let n = f.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    hash.update(&buf[..n]);
                }
                assert_eq!(
                    <[u8; 32]>::from(hash.finalize()),
                    record.digest,
                    "{}",
                    record.name
                );
                assert!(f.write_all(b"x").is_err());
            }
        },
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
    fs::copy(source.join(NAMES[0]), scratch.0.join(NAMES[0])).unwrap();
    let reject = |m: &[u8], signature: &[u8], expected: &str| {
        let result = implementation::verify_policy(
            &root,
            m,
            signature,
            &public_key,
            &implementation::REFERENCE,
            || {},
            |_| calls.set(calls.get() + 1),
        );
        let err = result.err().expect("must reject");
        assert!(
            err.to_string().contains(expected),
            "{err} did not contain {expected}"
        );
        assert_eq!(calls.get(), 1, "consumer must not run on failure");
    };
    let mut bad_sig = sig.as_ref().to_vec();
    bad_sig[0] ^= 1;
    reject(&manifest, &bad_sig, "signature");
    let mut bad_manifest = manifest.clone();
    bad_manifest.push(0);
    reject(&bad_manifest, key.sign(&bad_manifest).as_ref(), "extra");
    let extra = scratch.0.join("linux/extra");
    fs::write(&extra, b"x").unwrap();
    reject(&manifest, sig.as_ref(), "directory entries");
    fs::remove_file(extra).unwrap();
    let target = scratch.0.join(NAMES[0]);
    fs::remove_file(&target).unwrap();
    reject(&manifest, sig.as_ref(), "directory entries");
    symlink("/dev/null", &target).unwrap();
    reject(&manifest, sig.as_ref(), "Too many levels");
    fs::remove_file(&target).unwrap();
    fs::copy(source.join(NAMES[0]), &target).unwrap();
    let mut f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&target)
        .unwrap();
    let mut byte = [0];
    f.read_exact(&mut byte).unwrap();
    f.seek(SeekFrom::Start(0)).unwrap();
    f.write_all(&[byte[0] ^ 1]).unwrap();
    drop(f);
    reject(&manifest, sig.as_ref(), "digest");
}

#[test]
fn rejects_directory_substitution_before_consumer() {
    use sha2::{Digest, Sha256};
    use std::fs::{self, File};
    let dir = std::path::PathBuf::from(std::env::var_os("TMPDIR").unwrap())
        .join(format!("race-dir-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    for d in ["linux", "win"] {
        fs::create_dir(dir.join(d)).unwrap();
    }
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 3,
        digest: Sha256::digest(b"abc").into(),
    });
    for n in NAMES {
        fs::write(dir.join(n), b"abc").unwrap();
    }
    let root = File::open(&dir).unwrap();
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let m = encode(COMMIT, &records);
    let called = std::cell::Cell::new(false);
    let result = verify_with_hook(
        &root,
        &m,
        key.sign(&m).as_ref(),
        || {
            fs::rename(dir.join("linux"), dir.with_extension("old-linux")).unwrap();
            fs::create_dir(dir.join("linux")).unwrap();
            for n in &NAMES[..3] {
                fs::write(dir.join(n), b"abc").unwrap();
            }
        },
        |_| called.set(true),
    );
    fs::remove_dir_all(dir.with_extension("old-linux")).unwrap();
    let err = result.unwrap_err().to_string();
    assert!(err.contains("identity"), "unexpected error: {err}");
    assert!(!called.get());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rejects_file_substitution_before_consumer() {
    use sha2::{Digest, Sha256};
    use std::fs::{self, File};
    let dir = std::path::PathBuf::from(std::env::var_os("TMPDIR").unwrap())
        .join(format!("race-file-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    for d in ["linux", "win"] {
        fs::create_dir(dir.join(d)).unwrap();
    }
    let records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 3,
        digest: Sha256::digest(b"abc").into(),
    });
    for n in NAMES {
        fs::write(dir.join(n), b"abc").unwrap();
    }
    let root = File::open(&dir).unwrap();
    let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
    let m = encode(COMMIT, &records);
    let called = std::cell::Cell::new(false);
    let result = verify_with_hook(
        &root,
        &m,
        key.sign(&m).as_ref(),
        || {
            let path = dir.join(NAMES[1]);
            fs::rename(&path, dir.with_extension("old-file")).unwrap();
            fs::write(&path, b"abc").unwrap();
        },
        |_| called.set(true),
    );
    fs::remove_file(dir.with_extension("old-file")).unwrap();
    let err = result.unwrap_err().to_string();
    assert!(err.contains("identity"), "unexpected error: {err}");
    assert!(!called.get());
    fs::remove_dir_all(dir).unwrap();
}
