use super::*;
#[test]
fn production_fails_closed() {
    assert!(crate::production_verify().is_err());
    let root = std::fs::File::open(".").unwrap();
    assert!(crate::verify_release(&root, b"", b"").is_err());
}
use ring::signature::{Ed25519KeyPair, KeyPair};

fn test_key() -> Ed25519KeyPair {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
}
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
    let key = test_key();
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
    let wrong = test_key();
    assert!(authenticate(&m, sig.as_ref(), wrong.public_key().as_ref(), COMMIT).is_err());
}
#[test]
fn rejects_signed_noncanonical_records() {
    let key = test_key();
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
    let key = test_key();
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
    let key = test_key();
    let original = encode(COMMIT, &records);
    let check = |m: &[u8], sig: &[u8], expected: &str| {
        let called = std::cell::Cell::new(false);
        let e = verify(
            &root,
            m,
            sig,
            key.public_key().as_ref().try_into().unwrap(),
            |_| called.set(true),
        )
        .unwrap_err();
        assert!(
            e.to_string().contains(expected),
            "{e} did not contain {expected}"
        );
        assert!(!called.get());
        assert!(
            implementation::verify_fixed(
                &root,
                m,
                sig,
                key.public_key().as_ref().try_into().unwrap(),
                &implementation::REFERENCE,
            )
            .is_err()
        );
    };
    let sig = key.sign(&original);
    let wrong = test_key();
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
    // Exercise the fixed consumer against the actual candidate bytes. The
    // locally signed manifest and reference are fixtures, not release trust.
    let received = implementation::verify_fixed(
        &root,
        &manifest,
        sig.as_ref(),
        &public_key,
        &implementation::REFERENCE,
    )
    .unwrap();
    for (actual, expected) in received.iter().zip(&records) {
        assert_eq!(actual.name, expected.name);
        assert_eq!(actual.size, expected.size);
        assert_eq!(actual.digest, expected.digest);
    }
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
    let key = test_key();
    let m = encode(COMMIT, &records);
    let called = std::cell::Cell::new(false);
    let result = verify_with_hook(
        &root,
        &m,
        key.sign(&m).as_ref(),
        key.public_key().as_ref().try_into().unwrap(),
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
    let key = test_key();
    let m = encode(COMMIT, &records);
    let called = std::cell::Cell::new(false);
    let result = verify_with_hook(
        &root,
        &m,
        key.sign(&m).as_ref(),
        key.public_key().as_ref().try_into().unwrap(),
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

#[test]
fn signed_manifest_enforces_per_file_and_aggregate_limits() {
    let key = test_key();
    let mut records = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 1,
        digest: [0; 32],
    });
    let check = |records: &[Record; 5]| {
        let m = encode(COMMIT, records);
        authenticate(&m, key.sign(&m).as_ref(), key.public_key().as_ref(), COMMIT).map(|_| ())
    };
    records[0].size = 512 * 1024 * 1024;
    records[1].size = 512 * 1024 * 1024 - 3;
    assert!(check(&records).is_ok());
    records[1].size += 1;
    assert_eq!(check(&records), Err("total"));
    records[0].size += 1;
    assert_eq!(check(&records), Err("size"));
}

#[test]
fn seal_rejects_extra_input_and_oversize_before_reading() {
    use std::io::{self, Read};
    struct MustNotRead;
    impl Read for MustNotRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("oversize input was read")
        }
    }
    assert!(seal(&b"abcd"[..], 3).is_err());
    assert!(seal(MustNotRead, 512 * 1024 * 1024 + 1).is_err());
}

#[test]
fn fixed_consumer_rejects_bad_signature_without_report() {
    let root = std::fs::File::open(".").unwrap();
    let key = test_key();
    let result = implementation::verify_fixed(
        &root,
        b"bad",
        &[0; 64],
        key.public_key().as_ref().try_into().unwrap(),
        &implementation::REFERENCE,
    );
    assert!(result.is_err());
}

#[test]
fn fixed_consumer_rejects_each_bad_descriptor() {
    use sha2::{Digest, Sha256};
    use std::{
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::FileExt,
        },
    };
    let records: [Record; 5] = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: 3,
        digest: Sha256::digest(b"abc").into(),
    });
    let make = || std::array::from_fn(|_| seal(&b"abc"[..], 3).unwrap());
    let files: [std::fs::File; 5] = make();
    implementation::fixed_consume(&files, &records).unwrap();
    for i in 0..5 {
        let mut bad = records.clone();
        bad[i].size += 1;
        assert!(
            implementation::fixed_consume(&files, &bad)
                .unwrap_err()
                .to_string()
                .contains("consumer seals or size")
        );
        let mut bad = records.clone();
        bad[i].digest[0] ^= 1;
        assert!(
            implementation::fixed_consume(&files, &bad)
                .unwrap_err()
                .to_string()
                .contains("consumer digest")
        );
        let mut unsealed: [std::fs::File; 5] = make();
        let fd = unsafe {
            libc::memfd_create(
                c"unsealed-fixture".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        assert!(fd >= 0);
        let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
        f.write_all(b"abc").unwrap();
        unsealed[i] = f;
        assert_eq!(
            unsafe { libc::fcntl(unsealed[i].as_raw_fd(), libc::F_GET_SEALS) },
            0
        );
        assert!(
            implementation::fixed_consume(&unsealed, &records)
                .unwrap_err()
                .to_string()
                .contains("consumer seals or size")
        );
        for f in &unsealed {
            let mut b = [0; 3];
            f.read_exact_at(&mut b, 0).unwrap();
            assert_eq!(&b, b"abc");
        }
    }
}

#[test]
fn fixed_verifier_consumes_five_small_signed_fixtures() {
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{Cursor, Write},
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = Scratch(
        std::path::PathBuf::from(std::env::var_os("TMPDIR").unwrap()).join(format!(
            "fixed-consumer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )),
    );
    fs::create_dir(&dir.0).unwrap();
    fs::create_dir(dir.0.join("linux")).unwrap();
    fs::create_dir(dir.0.join("win")).unwrap();
    let apprun = b"synthetic test AppRun, not release trust";
    let mut squash = backhand::FilesystemWriter::default();
    squash.set_compressor(
        backhand::FilesystemCompressor::new(backhand::compression::Compressor::Gzip, None).unwrap(),
    );
    squash
        .push_file(
            Cursor::new(apprun.to_vec()),
            "AppRun",
            backhand::NodeHeader::default(),
        )
        .unwrap();
    let mut filesystem = Cursor::new(Vec::new());
    squash.write(&mut filesystem).unwrap();
    let mut image = vec![0u8; 128];
    image[..6].copy_from_slice(b"\x7fELF\x02\x01");
    image[40..48].copy_from_slice(&64u64.to_le_bytes());
    image[58..60].copy_from_slice(&64u16.to_le_bytes());
    image[60..62].copy_from_slice(&1u16.to_le_bytes());
    image.write_all(&filesystem.into_inner()).unwrap();
    let contents: [Vec<u8>; 5] = std::array::from_fn(|i| {
        if i == 0 {
            image.clone()
        } else {
            format!("synthetic artifact {i}").into_bytes()
        }
    });
    let records: [Record; 5] = std::array::from_fn(|i| Record {
        name: NAMES[i],
        size: contents[i].len() as u64,
        digest: Sha256::digest(&contents[i]).into(),
    });
    for i in 0..5 {
        fs::write(dir.0.join(NAMES[i]), &contents[i]).unwrap();
    }
    let root = fs::File::open(&dir.0).unwrap();
    let key = test_key();
    let manifest = encode(COMMIT, &records);
    let signature = key.sign(&manifest);
    let public = key.public_key().as_ref().try_into().unwrap();
    let reference = Sha256::digest(apprun).into();
    let result =
        implementation::verify_fixed(&root, &manifest, signature.as_ref(), public, &reference)
            .unwrap();
    for (actual, expected) in result.iter().zip(&records) {
        assert_eq!(
            (actual.name, actual.size, actual.digest),
            (expected.name, expected.size, expected.digest)
        );
    }
    let mut bad = signature.as_ref().to_vec();
    bad[0] ^= 1;
    assert!(implementation::verify_fixed(&root, &manifest, &bad, public, &reference).is_err());
    for i in 0..5 {
        assert_eq!(fs::read(dir.0.join(NAMES[i])).unwrap(), contents[i]);
    }
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
}

#[test]
fn opaque_policy_requires_independent_signed_approval() {
    let manifest_key = test_key();
    let approval_key = test_key();
    let record = Record {
        name: NAMES[0],
        size: 3,
        digest: [7; 32],
    };
    let approval = opaque::approval_bytes(record.size, &record.digest);
    assert!(
        opaque::authenticate_approval(
            &approval,
            approval_key.sign(&approval).as_ref(),
            approval_key.public_key().as_ref(),
            manifest_key.public_key().as_ref(),
            record.size,
            &record.digest
        )
        .is_ok()
    );
    assert!(
        opaque::authenticate_approval(
            &approval,
            manifest_key.sign(&approval).as_ref(),
            manifest_key.public_key().as_ref(),
            manifest_key.public_key().as_ref(),
            record.size,
            &record.digest
        )
        .is_err()
    );
}

#[test]
fn opaque_verifier_accepts_only_independently_approved_sealed_opaque_bytes() {
    use sha2::{Digest, Sha256};
    use std::fs;
    let dir = std::path::PathBuf::from(std::env::var_os("TMPDIR").unwrap())
        .join(format!("opaque-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    fs::create_dir(dir.join("linux")).unwrap();
    fs::create_dir(dir.join("win")).unwrap();
    for name in NAMES {
        fs::write(dir.join(name), b"abc").unwrap();
    }
    let records = std::array::from_fn(|i| opaque::Record {
        name: NAMES[i],
        size: 3,
        digest: Sha256::digest(b"abc").into(),
    });
    let manifest = opaque::encode(&records);
    let mk = test_key();
    let ak = test_key();
    let approval = opaque::approval_bytes(3, &records[0].digest);
    let root = fs::File::open(&dir).unwrap();
    assert!(
        opaque::verify(
            &root,
            &manifest,
            mk.sign(&manifest).as_ref(),
            mk.public_key().as_ref(),
            &approval,
            ak.sign(&approval).as_ref(),
            ak.public_key().as_ref()
        )
        .is_ok()
    );
    let ms = mk.sign(&manifest);
    let aps = ak.sign(&approval);
    let check = |m: &[u8], sig: &[u8], a: &[u8], asig: &[u8], akp: &[u8]| {
        opaque::verify(&root, m, sig, mk.public_key().as_ref(), a, asig, akp).is_err()
    };
    assert!(check(
        &manifest,
        &[0; 64],
        &approval,
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    assert!(check(
        &manifest,
        ms.as_ref(),
        &approval,
        &[0; 64],
        ak.public_key().as_ref()
    ));
    assert!(check(
        &manifest,
        ms.as_ref(),
        b"",
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    let mut malformed = approval.clone();
    malformed[0] ^= 1;
    assert!(check(
        &manifest,
        ms.as_ref(),
        &malformed,
        ak.sign(&malformed).as_ref(),
        ak.public_key().as_ref()
    ));
    assert!(check(
        &manifest,
        ms.as_ref(),
        &approval,
        aps.as_ref(),
        mk.public_key().as_ref()
    ));
    let mut extra_manifest = manifest.clone();
    extra_manifest.push(0);
    assert!(check(
        &extra_manifest,
        mk.sign(&extra_manifest).as_ref(),
        &approval,
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    fs::write(dir.join("linux/extra"), b"x").unwrap();
    assert!(check(
        &manifest,
        ms.as_ref(),
        &approval,
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    fs::remove_file(dir.join("linux/extra")).unwrap();
    fs::remove_file(dir.join(NAMES[1])).unwrap();
    std::os::unix::fs::symlink("/dev/null", dir.join(NAMES[1])).unwrap();
    assert!(check(
        &manifest,
        ms.as_ref(),
        &approval,
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    fs::remove_file(dir.join(NAMES[1])).unwrap();
    fs::write(dir.join(NAMES[1]), b"abcd").unwrap();
    assert!(check(
        &manifest,
        ms.as_ref(),
        &approval,
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    fs::write(dir.join(NAMES[1]), b"xyz").unwrap();
    assert!(check(
        &manifest,
        ms.as_ref(),
        &approval,
        aps.as_ref(),
        ak.public_key().as_ref()
    ));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn production_rejects_missing_opaque_trust_policy() {
    let root = std::fs::File::open(".").unwrap();
    assert_eq!(
        crate::verify_release(&root, b"", b"")
            .unwrap_err()
            .to_string(),
        "no approved opaque trust policy"
    );
}

#[test]
fn opaque_boundary_drops_owned_staging_handles_and_consumer_does_not_reopen() {
    // Source-level guard: this does not prove the absence of all possible I/O.
    let source = include_str!("opaque.rs");
    let verify = source.split("pub(super) fn verify(").nth(1).unwrap();
    let before_consumer = verify
        .split("fixed_consume(&files, &records)")
        .next()
        .unwrap();
    for handle in ["inputs", "linux", "win"] {
        assert!(
            before_consumer.contains(&format!("drop({handle});")),
            "{handle} must be dropped before consumption"
        );
    }
    let consumer = source
        .split("pub(super) fn fixed_consume(")
        .nth(1)
        .unwrap()
        .split("// The key and approval inputs")
        .next()
        .unwrap();
    assert!(!consumer.contains("open_component("));
    assert!(!consumer.contains("File::open("));
}

#[test]
#[ignore = "requires local release candidates and scratch capacity"]
fn opaque_real_candidate_copies_with_ephemeral_keys() {
    use sha2::{Digest, Sha256};
    use std::{fs, io::Read};
    let dir = std::path::PathBuf::from(std::env::var_os("TMPDIR").unwrap())
        .join(format!("opaque-real-{}", std::process::id()));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fs::create_dir(&dir).unwrap();
    let _cleanup = Cleanup(dir.clone());
    fs::create_dir(dir.join("linux")).unwrap();
    fs::create_dir(dir.join("win")).unwrap();
    let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../release");
    let mut records = Vec::new();
    for name in NAMES {
        fs::copy(source.join(name), dir.join(name)).unwrap();
        let mut file = fs::File::open(dir.join(name)).unwrap();
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
        records.push(opaque::Record {
            name,
            size,
            digest: hash.finalize().into(),
        });
    }
    let records: [opaque::Record; 5] = records.try_into().ok().unwrap();
    let manifest = opaque::encode(&records);
    let mk = test_key();
    let ak = test_key();
    let approval = opaque::approval_bytes(records[0].size, &records[0].digest);
    opaque::verify(
        &fs::File::open(&dir).unwrap(),
        &manifest,
        mk.sign(&manifest).as_ref(),
        mk.public_key().as_ref(),
        &approval,
        ak.sign(&approval).as_ref(),
        ak.public_key().as_ref(),
    )
    .unwrap();
}
