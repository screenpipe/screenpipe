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
# Self-signed, deliberately untrusted certificate used only as an Authenticode
# SignedData container. Its noncritical 2.25 UUID-derived extension is not an
# identity assertion and does not alter the original signer or signed image.
WINDOWS_DUMMY_CERT = base64.b64decode(
    'MIIDljCCAn6gAwIBAgIUPuLEEsjs5wDqHEi7isxK/wpeHw8wDQYJKoZIhvcNAQELBQAwKTEnMCUGA1UEAwweU2NyZWVucGlwZSBhdHRyaWJ1dGlvbiBjYXJyaWVyMB4XDTI2MTEwMjE3MTkwNVoXDTM2MTAzMDE3MTkwNVowKTEnMCUGA1UEAwweU2NyZWVucGlwZSBhdHRyaWJ1dGlvbiBjYXJyaWVyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqut+44LX4uLU8IykjHF8C3+g0krw4dsGvsEUbs+UFjG2HjxUJ5POy0lKEAFtaqNKpx1D6LrRWKxdqLp8EqjLFNAvblrtvxmGmZvE/3qWs1KsLOkzR3GEA9R2baDSX4KF7NZ0rSeRmJl4Y1q8wH29K3uFzUA9qdx8Mkx5RK6VmxMLXHEt6nd6hYj1GY9J4Tsjt/AsAeu8RiIgDHNyUZI7OkXOUSckgqz1UBrQOjyyB2EAl3+PcvPg8PbH7gEtOd8mYaHDDGNfw+aL1bil5JRk3sbNxLn+9zas5+ToVaF7GcUCiJBiHAJHIuykdMIScQPci/UVSAokF7Prf52AOsUPdQIDAQABo4G1MIGyMB0GA1UdDgQWBBQnzI1S5fhoX0c2cFPRa6qx7SgHJDAfBgNVHSMEGDAWgBQnzI1S5fhoX0c2cFPRa6qx7SgHJDAPBgNVHRMBAf8EBTADAQH/MF8GFGmCnrval9XQxobBjqavitPfkP4BBEcMRXVybjpzY3JlZW5waXBlOmFjcXVpc2l0aW9uLWdyYW50OjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMDANBgkqhkiG9w0BAQsFAAOCAQEAnoEOjwNe93RAoUikX+67BMbaXYRmppYN+vzr42kwG86FVPP6l4Js7zvCLc+B/4cJA5h82pzbO9kIMLnPf+ScJvZDJZQXBM2cEHqXydvj0pvJXLI7QpY/dLlzx6KXSDUvnN+OHsRJS8JjLsedgvu5fqfXHlgIoP++gzpk4ahFdAl5hnYjOFupQGpVjS6J8MNFF+6HtYKv6jgI9iXwLMy2N1/Ul1MTutCn1y9MIG1K6VKNKrPdHusGS5pKDuUUhPitRxU9nzUZbsLO03UCYOT61B27lg0+ShiMr31TCkQfPzmaRWTyOsUIkt9afAGspkTO/dmA2hVGRwb7kkgR01PP9w=='
)


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
    if WINDOWS_MARKER + PLACEHOLDER.encode() in certs:
        raise ValueError('Windows carrier certificate already present')
    children[index] = _der_wrap(0xa0, certs + WINDOWS_DUMMY_CERT)
    rebuilt_signed = _der_wrap(0x30, b''.join(children))
    rebuilt_explicit = _der_wrap(0xa0, rebuilt_signed)
    return _der_wrap(0x30, outer_children[0] + rebuilt_explicit)


def _prepare_windows_certificate(artifact):
    data = artifact.read_bytes()
    if len(data) < 0x40 or data[:2] != b'MZ':
        raise ValueError('invalid PE installer')
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    if pe + 24 > len(data) or data[pe:pe+4] != b'PE\0\0':
        raise ValueError('invalid PE header')
    optional_size = struct.unpack_from('<H', data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from('<H', data, optional)[0]
    directory = optional + (112 if magic == 0x20b else 96 if magic == 0x10b else -1)
    if directory < optional or directory + 8 * 5 > optional + optional_size:
        raise ValueError('PE has no valid certificate directory')
    size_offset = directory + 8 * 4 + 4
    cert_offset, cert_size = struct.unpack_from('<II', data, directory + 8 * 4)
    if cert_offset % 8 or cert_size < 8 or cert_offset + cert_size != len(data):
        raise ValueError('certificate table must be aligned and end the PE')
    win_length, revision, cert_type = struct.unpack_from('<IHH', data, cert_offset)
    if win_length > cert_size or revision != 0x200 or cert_type != 2:
        raise ValueError('unsupported WIN_CERTIFICATE')
    if any(data[cert_offset + win_length:cert_offset + cert_size]):
        raise ValueError('nonzero certificate padding')
    pkcs7 = data[cert_offset + 8:cert_offset + win_length]
    rebuilt = _insert_dummy_certificate(pkcs7)
    win_length = 8 + len(rebuilt)
    padded_size = (win_length + 7) & ~7
    certificate = struct.pack('<IHH', win_length, revision, cert_type) + rebuilt
    certificate += b'\0' * (padded_size - win_length)
    prepared = bytearray(data[:cert_offset]) + certificate
    struct.pack_into('<I', prepared, size_offset, padded_size)
    marker = WINDOWS_MARKER + PLACEHOLDER.encode()
    if prepared.count(marker) != 1:
        raise ValueError('ambiguous Windows carrier marker')
    return bytes(prepared), prepared.index(marker) + len(WINDOWS_MARKER)


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
    if not 100 <= size <= 2147483647:
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


def package_windows_certificate(artifact, output, platform, release):
    """Add a patchable untrusted certificate extension without changing signed image bytes."""
    if platform not in ('windows', 'windows-arm'):
        raise ValueError('Windows certificate carrier requires a Windows platform')
    artifact, output = Path(artifact).resolve(), Path(output).resolve()
    validate_artifact(artifact, platform, release)
    prepared, grant_offset = _prepare_windows_certificate(artifact)
    if len(prepared) > 2147483647:
        raise ValueError('carrier exceeds the website streaming limit')
    output.mkdir(parents=True, exist_ok=True)
    target = output / 'screenpipe-attribution-windows.exe'
    manifest = output / 'screenpipe-attribution-windows.json'
    if target.exists() or manifest.exists():
        raise ValueError('refusing to overwrite prepared artifacts')
    with target.open('xb') as destination:
        destination.write(prepared)
    # Recheck the exact bytes after writing; the original signed-image digest
    # and signer are subsequently verified by the release workflow on Windows.
    if prepared[grant_offset:grant_offset + 36] != PLACEHOLDER.encode():
        raise ValueError('Windows grant patch location is invalid')
    result = dict(
        schema=4, carrier='windows-certificate', platform=platform, release=release,
        size=len(prepared), sha256=hashlib.sha256(prepared).hexdigest(),
        patch=dict(offset=grant_offset, length=36, placeholder=PLACEHOLDER),
        certificate=dict(oid=WINDOWS_OID, critical=False,
                         marker=WINDOWS_MARKER.decode(), table_at_end=True),
    )
    with manifest.open('x') as destination:
        json.dump(result, destination, indent=2)
        destination.write('\n')
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
    args = parser.parse_args()
    if args.linux_xattr and (not args.artifact or args.platform != 'linux'):
        parser.error('--linux-xattr requires --artifact and --platform linux')
    if args.windows_certificate and (not args.artifact or not args.platform.startswith('windows')):
        parser.error('--windows-certificate requires a Windows --artifact')
    if args.windows_certificate and args.linux_xattr:
        parser.error('carrier modes are mutually exclusive')
    prepare = (package_windows_certificate if args.windows_certificate else
               package_linux_xattr if args.linux_xattr else package if args.app else package_filename)
    for artifact in prepare(args.app or args.artifact, args.output, args.platform, args.release):
        print(artifact)
