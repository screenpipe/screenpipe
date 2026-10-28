#!/usr/bin/env python3
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Prepare a versioned download carrier from a release artifact. Never uploads/publishes."""
import argparse
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
import tempfile
import zipfile

PLACEHOLDER = '00000000-0000-4000-8000-000000000000'


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


def package_filename(artifact, output, platform, release):
    """Copy an immutable executable; only its delivered filename is personalized."""
    artifact, output = Path(artifact).resolve(), Path(output).resolve()
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


def windows_metadata(artifact):
    """Read signature and version using Windows' supported PowerShell APIs."""
    if sys.platform != 'win32':
        raise ValueError('Windows packaging requires a Windows host')
    script = ("$ErrorActionPreference='Stop';$p=$env:SCREENPIPE_ATTRIBUTION_ARTIFACT;"
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
    args = parser.parse_args()
    prepare = package if args.app else package_filename
    for artifact in prepare(args.app or args.artifact, args.output, args.platform, args.release):
        print(artifact)
