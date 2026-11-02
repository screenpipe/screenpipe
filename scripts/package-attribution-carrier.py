#!/usr/bin/env python3
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Prepare a versioned download carrier from a release artifact. Never uploads/publishes."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import plistlib
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile

PLACEHOLDER = '00000000-0000-4000-8000-000000000000'
LINUX_XATTR = 'user.screenpipe.acquisition-grant'
WINDOWS_OID = '2.25.190389607246623950780965390285594181377'
WINDOWS_MARKER = b'urn:screenpipe:acquisition-grant:'
LEGACY_SCHEMA1_STREAMING_MAX = 2147483647
# Self-signed, deliberately untrusted certificate used only as an Authenticode
# SignedData container. Its noncritical 2.25 UUID-derived extension is not an
# identity assertion and does not alter the original signer or signed image.
WINDOWS_DUMMY_CERT = base64.b64decode(
    'MIIDljCCAn6gAwIBAgIUPuLEEsjs5wDqHEi7isxK/wpeHw8wDQYJKoZIhvcNAQELBQAwKTEnMCUGA1UEAwweU2NyZWVucGlwZSBhdHRyaWJ1dGlvbiBjYXJyaWVyMB4XDTI2MTEwMjE3MTkwNVoXDTM2MTAzMDE3MTkwNVowKTEnMCUGA1UEAwweU2NyZWVucGlwZSBhdHRyaWJ1dGlvbiBjYXJyaWVyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqut+44LX4uLU8IykjHF8C3+g0krw4dsGvsEUbs+UFjG2HjxUJ5POy0lKEAFtaqNKpx1D6LrRWKxdqLp8EqjLFNAvblrtvxmGmZvE/3qWs1KsLOkzR3GEA9R2baDSX4KF7NZ0rSeRmJl4Y1q8wH29K3uFzUA9qdx8Mkx5RK6VmxMLXHEt6nd6hYj1GY9J4Tsjt/AsAeu8RiIgDHNyUZI7OkXOUSckgqz1UBrQOjyyB2EAl3+PcvPg8PbH7gEtOd8mYaHDDGNfw+aL1bil5JRk3sbNxLn+9zas5+ToVaF7GcUCiJBiHAJHIuykdMIScQPci/UVSAokF7Prf52AOsUPdQIDAQABo4G1MIGyMB0GA1UdDgQWBBQnzI1S5fhoX0c2cFPRa6qx7SgHJDAfBgNVHSMEGDAWgBQnzI1S5fhoX0c2cFPRa6qx7SgHJDAPBgNVHRMBAf8EBTADAQH/MF8GFGmCnrval9XQxobBjqavitPfkP4BBEcMRXVybjpzY3JlZW5waXBlOmFjcXVpc2l0aW9uLWdyYW50OjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMDANBgkqhkiG9w0BAQsFAAOCAQEAnoEOjwNe93RAoUikX+67BMbaXYRmppYN+vzr42kwG86FVPP6l4Js7zvCLc+B/4cJA5h82pzbO9kIMLnPf+ScJvZDJZQXBM2cEHqXydvj0pvJXLI7QpY/dLlzx6KXSDUvnN+OHsRJS8JjLsedgvu5fqfXHlgIoP++gzpk4ahFdAl5hnYjOFupQGpVjS6J8MNFF+6HtYKv6jgI9iXwLMy2N1/Ul1MTutCn1y9MIG1K6VKNKrPdHusGS5pKDuUUhPitRxU9nzUZbsLO03UCYOT61B27lg0+ShiMr31TCkQfPzmaRWTyOsUIkt9afAGspkTO/dmA2hVGRwb7kkgR01PP9w=='
)


def _sha256_path(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _der_length(length):
    if length < 128:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(encoded)]) + encoded


def _der_tlv(data, offset=0):
    if offset + 2 > len(data):
        raise ValueError('truncated DER object')
    tag, first = data[offset], data[offset + 1]
    if first < 128:
        length, header = first, 2
    else:
        count = first & 0x7f
        if not count or offset + 2 + count > len(data):
            raise ValueError('invalid DER length')
        length, header = int.from_bytes(data[offset + 2:offset + 2 + count], 'big'), 2 + count
    end = offset + header + length
    if end > len(data):
        raise ValueError('truncated DER value')
    return tag, offset + header, end


def _der_wrap(tag, value):
    return bytes([tag]) + _der_length(len(value)) + value


def _der_oid(oid):
    arcs = [int(part) for part in oid.split('.')]
    encoded = bytearray([40 * arcs[0] + arcs[1]])
    for arc in arcs[2:]:
        groups = [arc & 0x7f]
        arc >>= 7
        while arc:
            groups.append(0x80 | (arc & 0x7f))
            arc >>= 7
        encoded.extend(reversed(groups))
    return _der_wrap(0x06, bytes(encoded))


def _certificate_extensions(certificate):
    """Yield structurally parsed (OID TLV, critical, extnValue contents)."""
    tag, cert_value, cert_end = _der_tlv(certificate)
    if tag != 0x30 or cert_end != len(certificate):
        raise ValueError('invalid X.509 certificate')
    tag, tbs_value, tbs_end = _der_tlv(certificate, cert_value)
    if tag != 0x30:
        raise ValueError('invalid X.509 TBSCertificate')
    cursor = tbs_value
    while cursor < tbs_end:
        child = _der_tlv(certificate, cursor)
        if child[0] == 0xa3:
            tag, extensions_value, extensions_end = _der_tlv(certificate, child[1])
            if tag != 0x30 or extensions_end != child[2]:
                raise ValueError('invalid X.509 extensions')
            extension = extensions_value
            while extension < extensions_end:
                tag, value, end = _der_tlv(certificate, extension)
                if tag != 0x30:
                    raise ValueError('invalid X.509 extension')
                oid = _der_tlv(certificate, value)
                oid_tlv = certificate[value:oid[2]]
                field = oid[2]
                critical = False
                next_field = _der_tlv(certificate, field)
                if next_field[0] == 0x01:
                    critical = certificate[next_field[1]:next_field[2]] != b'\0'
                    field = next_field[2]
                    next_field = _der_tlv(certificate, field)
                if next_field[0] != 0x04 or next_field[2] != end:
                    raise ValueError('invalid X.509 extension value')
                yield oid_tlv, critical, certificate[next_field[1]:next_field[2]]
                extension = end
            return
        cursor = child[2]


def _matching_extensions(certs):
    wanted = _der_oid(WINDOWS_OID)
    matches = []
    cursor = 0
    while cursor < len(certs):
        cert = _der_tlv(certs, cursor)
        if cert[0] != 0x30:
            raise ValueError('unsupported certificate choice')
        matches.extend((critical, value) for oid, critical, value in
                       _certificate_extensions(certs[cursor:cert[2]]) if oid == wanted)
        cursor = cert[2]
    return matches


def _insert_dummy_certificate(pkcs7):
    # ContentInfo SEQUENCE -> [0] EXPLICIT -> SignedData SEQUENCE. Preserve all
    # primitive bytes and only rebuild the enclosing lengths and certificate SET.
    tag, outer_value, outer_end = _der_tlv(pkcs7)
    if tag != 0x30 or any(pkcs7[outer_end:]):
        raise ValueError('invalid PKCS7 ContentInfo')
    pkcs7 = pkcs7[:outer_end]
    outer_children = []
    cursor = outer_value
    while cursor < outer_end:
        child = _der_tlv(pkcs7, cursor)
        outer_children.append(pkcs7[cursor:child[2]])
        cursor = child[2]
    if len(outer_children) != 2 or outer_children[1][0] != 0xa0:
        raise ValueError('PKCS7 is not explicit SignedData')
    _, explicit_value, explicit_end = _der_tlv(outer_children[1])
    signed = outer_children[1][explicit_value:explicit_end]
    _, signed_value, signed_end = _der_tlv(signed)
    children, cursor = [], signed_value
    while cursor < signed_end:
        child = _der_tlv(signed, cursor)
        children.append(signed[cursor:child[2]])
        cursor = child[2]
    cert_indexes = [i for i, child in enumerate(children) if child[0] == 0xa0]
    if len(cert_indexes) != 1:
        raise ValueError('PKCS7 must contain one certificate set')
    index = cert_indexes[0]
    _, cert_value, cert_end = _der_tlv(children[index])
    certs = children[index][cert_value:cert_end]
    if _matching_extensions(certs):
        raise ValueError('Windows carrier certificate already present')
    encoded_certificates = []
    cursor = 0
    while cursor < len(certs):
        certificate = _der_tlv(certs, cursor)
        encoded_certificates.append(certs[cursor:certificate[2]])
        cursor = certificate[2]
    encoded_certificates.append(WINDOWS_DUMMY_CERT)
    canonical_certificates = b''.join(sorted(encoded_certificates))
    children[index] = _der_wrap(0xa0, canonical_certificates)
    matches = _matching_extensions(canonical_certificates)
    expected = _der_wrap(0x0c, WINDOWS_MARKER + PLACEHOLDER.encode())
    if matches != [(False, expected)]:
        raise ValueError('invalid Windows carrier extension contract')
    rebuilt_signed = _der_wrap(0x30, b''.join(children))
    rebuilt_explicit = _der_wrap(0xa0, rebuilt_signed)
    return _der_wrap(0x30, outer_children[0] + rebuilt_explicit)


def _prepare_windows_certificate(source, source_size):
    """Return (certificate offset, replacement table, grant offset in table)."""
    def read_exact_at(offset, length, description):
        if offset < 0 or length < 0 or offset > source_size or length > source_size - offset:
            raise ValueError(f'{description} is outside installer')
        source.seek(offset)
        value = source.read(length)
        if len(value) != length:
            raise ValueError('installer changed while reading ' + description)
        return value

    dos = read_exact_at(0, 0x40, 'DOS header') if source_size >= 0x40 else b''
    if len(dos) != 0x40 or dos[:2] != b'MZ':
        raise ValueError('invalid PE installer')
    pe = struct.unpack_from('<I', dos, 0x3c)[0]
    coff = read_exact_at(pe, 24, 'PE header')
    if coff[:4] != b'PE\0\0':
        raise ValueError('invalid PE header')
    optional_size = struct.unpack_from('<H', coff, 20)[0]
    optional_offset = pe + 24
    optional = read_exact_at(optional_offset, optional_size, 'PE optional header')
    if len(optional) < 2:
        raise ValueError('PE has no valid certificate directory')
    magic = struct.unpack_from('<H', optional)[0]
    directory = 112 if magic == 0x20b else 96 if magic == 0x10b else -1
    if directory < 0 or directory + 8 * 5 > len(optional):
        raise ValueError('PE has no valid certificate directory')
    size_offset = optional_offset + directory + 8 * 4 + 4
    cert_offset, cert_size = struct.unpack_from('<II', optional, directory + 8 * 4)
    if (cert_offset % 8 or cert_size < 8 or cert_offset > source_size or
            cert_size != source_size - cert_offset):
        raise ValueError('certificate table must be aligned and end the PE')
    win_header = read_exact_at(cert_offset, 8, 'WIN_CERTIFICATE header')
    win_length, revision, cert_type = struct.unpack('<IHH', win_header)
    if win_length > cert_size or revision != 0x200 or cert_type != 2:
        raise ValueError('unsupported WIN_CERTIFICATE')
    pkcs7_size = win_length - 8
    if pkcs7_size < 2:
        raise ValueError('unsupported WIN_CERTIFICATE')
    # Allocate the SignedData's actual DER length, not the certificate table's
    # declared size. Padding is checked incrementally below.
    der_prefix = read_exact_at(cert_offset + 8, min(6, pkcs7_size), 'PKCS7 header')
    first_length = 2 if der_prefix[1] < 0x80 else 2 + (der_prefix[1] & 0x7f)
    if first_length > len(der_prefix):
        raise ValueError('invalid PKCS7 length')
    if der_prefix[1] < 0x80:
        encoded_size = 2 + der_prefix[1]
    else:
        count = der_prefix[1] & 0x7f
        if count == 0 or count > 4 or der_prefix[2] == 0:
            raise ValueError('invalid PKCS7 length')
        encoded_size = first_length + int.from_bytes(der_prefix[2:first_length], 'big')
    if encoded_size > pkcs7_size:
        raise ValueError('WIN_CERTIFICATE length does not match PKCS7')
    pkcs7 = read_exact_at(cert_offset + 8, encoded_size, 'PKCS7 SignedData')
    # signtool may include the record's alignment zeros in dwLength. Treat
    # both that representation and padding after dwLength identically: every
    # byte between the DER object and the table end must be zero.
    source.seek(cert_offset + 8 + encoded_size)
    padding = cert_size - 8 - encoded_size
    while padding:
        block = source.read(min(1024 * 1024, padding))
        if not block or any(block):
            raise ValueError('nonzero or truncated certificate padding')
        padding -= len(block)
    rebuilt = _insert_dummy_certificate(pkcs7)
    win_length = 8 + len(rebuilt)
    padded_size = (win_length + 7) & ~7
    certificate = struct.pack('<IHH', win_length, revision, cert_type) + rebuilt
    certificate += b'\0' * (padded_size - win_length)
    # The size field is before cert_offset and is patched while streaming.
    marker = WINDOWS_MARKER + PLACEHOLDER.encode()
    if certificate.count(marker) != 1:
        raise ValueError('ambiguous Windows carrier marker')
    return cert_offset, size_offset, certificate, certificate.index(marker) + len(WINDOWS_MARKER)


def package(app, output, platform, release):
    app, output = Path(app).resolve(), Path(output).resolve()
    if app.suffix != '.app' or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', release):
        raise ValueError('signed .app and valid release required')
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleShortVersionString') != release:
        raise ValueError('release must match the app version')
    executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
    expected_arch = {'macos-arm': 'arm64', 'macos-intel': 'x86_64'}[platform]
    architectures = subprocess.check_output(['lipo', '-archs', str(executable)]).decode().split()
    if not any(arch == expected_arch or (expected_arch == 'arm64' and arch == 'arm64e') for arch in architectures):
        raise ValueError('platform does not match the signed executable')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'screenpipe-attribution.zip'
    manifest = output / 'screenpipe-attribution.json'
    if archive.exists() or manifest.exists():
        raise ValueError('refusing to overwrite prepared artifacts')
    with tempfile.TemporaryDirectory(prefix='screenpipe-carrier-') as tmp:
        tmp = Path(tmp)
        container = tmp / 'root'
        container.mkdir()
        copied = container / app.name
        subprocess.run(['ditto', str(app), str(copied)], check=True)
        subprocess.run(['xattr', '-w', 'com.apple.application-instance', PLACEHOLDER, str(copied)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(copied)], check=True)
        original = tmp / 'original.zip'
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', str(container), str(original)], check=True)
        member_name = '__MACOSX/._' + app.name
        prepared = tmp / 'prepared.zip'
        with zipfile.ZipFile(original) as src, zipfile.ZipFile(prepared, 'w', allowZip64=False) as dst:
            for entry in src.infolist():
                if entry.filename == member_name:
                    payload = src.read(entry)
                    if payload.count(PLACEHOLDER.encode()) != 1:
                        raise ValueError('ambiguous or absent xattr placeholder')
                    entry.compress_type = zipfile.ZIP_STORED
                    entry.extra = b''
                    entry.comment = b''
                    dst.writestr(entry, payload)
                else:
                    with src.open(entry) as source, dst.open(entry, 'w') as target:
                        shutil.copyfileobj(source, target, 1024 * 1024)
        with zipfile.ZipFile(prepared) as z:
            entry = z.getinfo(member_name)
            payload = z.read(entry)
            central = z.start_dir
            with prepared.open('rb') as f:
                while True:
                    f.seek(central)
                    header = f.read(46)
                    if header[:4] != b'PK\x01\x02':
                        raise ValueError('missing carrier central entry')
                    namesize, extrasize, commentsize = struct.unpack_from('<HHH', header, 28)
                    name = f.read(namesize).decode('utf-8')
                    if name == member_name:
                        break
                    central += 46 + namesize + extrasize + commentsize
        size = prepared.stat().st_size
        if size > 2147483647:
            raise ValueError('carrier exceeds the website streaming limit')
        digest = hashlib.sha256()
        with prepared.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(block)
        result = dict(schema=1, platform=platform, release=release, size=size,
                      sha256=digest.hexdigest(), placeholder=PLACEHOLDER,
                      member=dict(name=member_name, data_offset=entry.header_offset+30+len(member_name.encode()),
                                  data_length=len(payload), grant_offset=payload.index(PLACEHOLDER.encode()),
                                  crc32=entry.CRC, local_crc_offset=entry.header_offset+14,
                                  central_crc_offset=central+16))
        # Check the actual archive extraction, including metadata and signature.
        extracted = tmp / 'extracted'
        subprocess.run(['ditto', '-x', '-k', str(prepared), str(extracted)], check=True)
        extracted_app = extracted / app.name
        received = subprocess.check_output(['xattr', '-p', 'com.apple.application-instance', str(extracted_app)]).decode().strip()
        if received != PLACEHOLDER:
            raise ValueError('archive lost the application instance attribute')
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(extracted_app)], check=True)
        shutil.copyfile(prepared, archive)
        manifest.write_text(json.dumps(result, indent=2)+'\n')
    return archive, manifest


def validate_artifact(artifact, platform, release):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', release):
        raise ValueError('valid release required')
    if not re.search(r'(?:^|[_-])' + re.escape(release) + r'(?:[_-]|\.)', artifact.name):
        raise ValueError('release must match the versioned artifact filename')
    if platform not in ('linux', 'windows', 'windows-arm'):
        raise ValueError('unsupported filename platform')
    if platform == 'linux':
        with artifact.open('rb') as source:
            header = source.read(20)
        if (artifact.suffix != '.AppImage' or header[:6] != b'\x7fELF\x02\x01' or
                header[8:11] != b'AI\x02' or len(header) != 20 or struct.unpack_from('<H', header, 18)[0] != 62):
            raise ValueError('Linux x86_64 type-2 AppImage required')
    else:
        if artifact.suffix.lower() != '.exe':
            raise ValueError('Windows installer .exe required')
        arch = (r'(?:^|[_-])(?:x64|x86_64|amd64)(?:[_-]|\.)' if platform == 'windows'
                else r'(?:^|[_-])(?:arm64|aarch64)(?:[_-]|\.)')
        if not re.search(arch, artifact.name, re.IGNORECASE):
            raise ValueError('versioned release filename lacks target architecture evidence')
        metadata = windows_metadata(artifact)
        if metadata.get('Status') != 'Valid':
            raise ValueError('installer must have a valid Authenticode signature')
        versions = {str(metadata.get(key, '')).strip() for key in ('ProductVersion', 'FileVersion')}
        if release not in versions:
            raise ValueError('release must match Windows version metadata')


def package_filename(artifact, output, platform, release):
    """Copy an immutable executable; only its delivered filename is personalized."""
    artifact, output = Path(artifact).resolve(), Path(output).resolve()
    validate_artifact(artifact, platform, release)
    size = artifact.stat().st_size
    if not 100 <= size <= LEGACY_SCHEMA1_STREAMING_MAX:
        raise ValueError('carrier size outside streaming limit')
    output.mkdir(parents=True, exist_ok=True)
    target = output / ('screenpipe-attribution.exe' if platform.startswith('windows')
                       else 'screenpipe-attribution.AppImage')
    manifest = output / 'screenpipe-attribution.json'
    if target.exists() or manifest.exists():
        raise ValueError('refusing to overwrite prepared artifacts')
    digest = hashlib.sha256()
    # Hash the exact bytes being copied, with exclusive creation.
    with artifact.open('rb') as source, target.open('xb') as destination:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
            destination.write(block)
    if target.stat().st_size != size:
        target.unlink()
        raise ValueError('artifact changed during copy')
    target.chmod(artifact.stat().st_mode & 0o777)
    with manifest.open('x') as destination:
        json.dump(dict(schema=1, carrier='filename', platform=platform, release=release,
                       size=size, sha256=digest.hexdigest()), destination, indent=2)
        destination.write('\n')
    return target, manifest


def package_windows_release_carriers(artifact, output, platform, release):
    """Prepare schema 4 and, where Website schema 1 supports it, compatibility output."""
    artifact, output = Path(artifact).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('refusing to overwrite prepared artifacts')
    with tempfile.TemporaryDirectory(prefix='.screenpipe-windows-carriers-', dir=output.parent) as staging:
        staging = Path(staging)
        package_windows_certificate(artifact, staging, platform, release)
        source_size = artifact.stat().st_size
        if source_size <= LEGACY_SCHEMA1_STREAMING_MAX:
            package_filename(artifact, staging, platform, release)
        else:
            print(f'legacy schema 1 filename carrier omitted: source size {source_size} bytes exceeds '
                  f'Website schema 1 streaming limit {LEGACY_SCHEMA1_STREAMING_MAX} bytes; '
                  'schema 4 Windows certificate carrier prepared',
                  file=sys.stderr)
        prepared = tuple(staging.iterdir())
        published = []
        try:
            for item in prepared:
                destination = output / item.name
                os.link(item, destination)
                published.append(destination)
                item.unlink()
        except Exception:
            for destination in published:
                destination.unlink(missing_ok=True)
            raise
    return tuple(output / item.name for item in prepared)


def package_windows_certificate(artifact, output, platform, release):
    """Add a patchable untrusted certificate extension without changing signed image bytes."""
    if platform not in ('windows', 'windows-arm'):
        raise ValueError('Windows certificate carrier requires a Windows platform')
    artifact, output = Path(artifact).resolve(), Path(output).resolve()
    validate_artifact(artifact, platform, release)
    output.mkdir(parents=True, exist_ok=True)
    target = output / 'screenpipe-attribution-windows.exe'
    manifest = output / 'screenpipe-attribution-windows.json'
    if target.exists() or manifest.exists():
        if manifest.exists():
            raise ValueError('refusing to overwrite prepared artifacts')
    before = artifact.stat()
    digest = hashlib.sha256()
    temporary = None
    manifest_name = None
    target_created = False
    try:
        with artifact.open('rb') as source:
            cert_offset, size_offset, certificate, relative_grant = _prepare_windows_certificate(source, before.st_size)
            grant_offset = cert_offset + relative_grant
            fd, temporary_name = tempfile.mkstemp(prefix='.screenpipe-attribution-windows-', suffix='.tmp', dir=output)
            os.close(fd)
            temporary = Path(temporary_name)
            with temporary.open('wb') as destination:
                def copy_bytes(length):
                    while length:
                        block = source.read(min(1024 * 1024, length))
                        if not block:
                            raise ValueError('installer changed during streaming copy')
                        destination.write(block)
                        digest.update(block)
                        length -= len(block)

                source.seek(0)
                copy_bytes(size_offset)
                replacement = struct.pack('<I', len(certificate))
                destination.write(replacement)
                digest.update(replacement)
                source.seek(size_offset + 4)
                copy_bytes(cert_offset - size_offset - 4)
                destination.write(certificate)
                digest.update(certificate)
        after = artifact.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('installer changed during streaming copy')
        try:
            os.link(temporary, target)
            target_created = True
            temporary.unlink()
            temporary = None
        except FileExistsError:
            # A killed preparation may have published the complete executable
            # immediately before committing its manifest. Resume only when the
            # bytes prove that this is precisely our deterministic output.
            if (target.stat().st_size != temporary.stat().st_size or
                    _sha256_path(target) != digest.hexdigest()):
                raise ValueError('refusing to overwrite prepared artifacts')
            temporary.unlink()
            temporary = None
    except Exception:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise
    prepared_size = target.stat().st_size
    with target.open('rb') as prepared:
        prepared.seek(grant_offset)
        if prepared.read(36) != PLACEHOLDER.encode():
            raise ValueError('Windows grant patch location is invalid')
    result = dict(
        schema=4, carrier='windows-certificate', platform=platform, release=release,
        size=prepared_size, sha256=digest.hexdigest(),
        patch=dict(offset=grant_offset, length=36, placeholder=PLACEHOLDER),
        certificate=dict(oid=WINDOWS_OID, critical=False,
                         marker=WINDOWS_MARKER.decode(), table_at_end=True),
    )
    try:
        fd, manifest_name = tempfile.mkstemp(prefix='.screenpipe-attribution-windows-', suffix='.json.tmp', dir=output)
        with os.fdopen(fd, 'w') as destination:
            json.dump(result, destination, indent=2)
            destination.write('\n')
            destination.flush()
            os.fsync(destination.fileno())
        os.link(manifest_name, manifest)
        Path(manifest_name).unlink()
        manifest_name = None
    except Exception:
        if manifest_name is not None:
            Path(manifest_name).unlink(missing_ok=True)
        if target_created:
            target.unlink(missing_ok=True)
        raise
    return target, manifest


def package_linux_xattr(artifact, output, platform, release):
    """PAX metadata personalizes the file's xattr without changing AppImage bytes."""
    if platform != 'linux':
        raise ValueError('Linux xattr carrier requires platform linux')
    artifact, output = Path(artifact).resolve(), Path(output).resolve()
    validate_artifact(artifact, platform, release)
    original_size = artifact.stat().st_size
    original_digest = hashlib.sha256()
    with artifact.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            original_digest.update(block)
    with tempfile.TemporaryDirectory(prefix='screenpipe-linux-carrier-') as tmp:
        member = tarfile.TarInfo('screenpipe.AppImage')
        member.size = original_size
        member.mode = 0o755
        member.pax_headers = {'SCHILY.xattr.' + LINUX_XATTR: PLACEHOLDER}
        prefix = member.tobuf(format=tarfile.PAX_FORMAT)
        if prefix.count(PLACEHOLDER.encode()) != 1:
            raise ValueError('ambiguous or absent Linux xattr placeholder')
        prepared = Path(tmp) / 'screenpipe-attribution.tar'
        with tarfile.open(prepared, 'w', format=tarfile.PAX_FORMAT) as archive:
            with artifact.open('rb') as source:
                archive.addfile(member, source)
        # Check the exact archived bytes, including a source modified mid-copy.
        archived_digest = hashlib.sha256()
        with tarfile.open(prepared) as archive:
            source = archive.extractfile(member.name)
            for block in iter(lambda: source.read(1024 * 1024), b''):
                archived_digest.update(block)
        if artifact.stat().st_size != original_size or archived_digest.digest() != original_digest.digest():
            raise ValueError('artifact changed during copy')
        digest = hashlib.sha256()
        with prepared.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        output.mkdir(parents=True, exist_ok=True)
        archive = output / prepared.name
        manifest = output / 'screenpipe-attribution-linux.json'
        if archive.exists() or manifest.exists():
            raise ValueError('refusing to overwrite prepared artifacts')
        result = dict(schema=3, carrier='linux-xattr', platform=platform, release=release,
                      size=prepared.stat().st_size, sha256=digest.hexdigest(),
                      placeholder=PLACEHOLDER, grant_offset=prefix.index(PLACEHOLDER.encode()),
                      appimage=dict(name=member.name, size=member.size, sha256=original_digest.hexdigest()))
        with prepared.open('rb') as source, archive.open('xb') as destination:
            shutil.copyfileobj(source, destination, 1024 * 1024)
        with manifest.open('x') as destination:
            json.dump(result, destination, indent=2)
            destination.write('\n')
    return archive, manifest


def windows_metadata(artifact):
    """Read signature and version using Windows' supported PowerShell APIs."""
    if sys.platform != 'win32':
        raise ValueError('Windows packaging requires a Windows host')
    script = ("$ErrorActionPreference='Stop';"
              "Import-Module ($env:WINDIR+'\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');"
              "$p=$env:SCREENPIPE_ATTRIBUTION_ARTIFACT;"
              "$s=Get-AuthenticodeSignature -LiteralPath $p;"
              "$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p);"
              "@{Status=[string]$s.Status;ProductVersion=$v.ProductVersion;"
              "FileVersion=$v.FileVersion}|ConvertTo-Json -Compress")
    output = subprocess.check_output([
        'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script
    ], text=True, timeout=30, env={**os.environ, 'SCREENPIPE_ATTRIBUTION_ARTIFACT': str(artifact)})
    return json.loads(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--app')
    inputs.add_argument('--artifact')
    parser.add_argument('--output', required=True)
    parser.add_argument('--platform', choices=['macos-arm', 'macos-intel', 'linux', 'windows', 'windows-arm'], required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--linux-xattr', action='store_true', help='prepare a Linux PAX tar xattr carrier')
    parser.add_argument('--windows-certificate', action='store_true', help='prepare a Windows certificate carrier')
    parser.add_argument('--windows-release-carriers', action='store_true',
                        help='prepare schema 4 plus supported schema 1 Windows compatibility output')
    args = parser.parse_args()
    if args.linux_xattr and (not args.artifact or args.platform != 'linux'):
        parser.error('--linux-xattr requires --artifact and --platform linux')
    if args.windows_certificate and (not args.artifact or not args.platform.startswith('windows')):
        parser.error('--windows-certificate requires a Windows --artifact')
    if args.windows_certificate and args.linux_xattr:
        parser.error('carrier modes are mutually exclusive')
    if args.windows_release_carriers and (not args.artifact or not args.platform.startswith('windows')):
        parser.error('--windows-release-carriers requires a Windows --artifact')
    if sum((args.windows_certificate, args.windows_release_carriers, args.linux_xattr)) > 1:
        parser.error('carrier modes are mutually exclusive')
    prepare = (package_windows_release_carriers if args.windows_release_carriers else
               package_windows_certificate if args.windows_certificate else
               package_linux_xattr if args.linux_xattr else package if args.app else package_filename)
    for artifact in prepare(args.app or args.artifact, args.output, args.platform, args.release):
        print(artifact)
