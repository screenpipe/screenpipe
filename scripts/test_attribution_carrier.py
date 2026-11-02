# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Local attribution-carrier packaging regressions; never publish artifacts."""
import importlib.util
import hashlib
import json
import os
import sys
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import tarfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('carrier', Path(__file__).with_name('package-attribution-carrier.py'))
carrier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(carrier)


class CarrierTest(unittest.TestCase):
    def test_linux_xattr_tar_preserves_appimage_and_exact_patch_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / 'screenpipe_1.2.3_amd64.AppImage'
            content = bytearray(2049)
            content[:6] = b'\x7fELF\x02\x01'
            content[8:11] = b'AI\x02'
            content[18] = 62
            # The same bytes in the executable must never be personalized.
            content[100:136] = carrier.PLACEHOLDER.encode()
            artifact.write_bytes(content)
            prepared, manifest = carrier.package_linux_xattr(artifact, root / 'out', 'linux', '1.2.3')
            data = json.loads(manifest.read_text())
            self.assertEqual(data['schema'], 3)
            self.assertEqual(data['carrier'], 'linux-xattr')
            self.assertEqual(data['size'], prepared.stat().st_size)
            self.assertEqual(data['sha256'], hashlib.sha256(prepared.read_bytes()).hexdigest())
            self.assertEqual(data['appimage'], dict(name='screenpipe.AppImage', size=len(content),
                                                   sha256=hashlib.sha256(content).hexdigest()))
            grant = '12345678-1234-4234-8234-123456789012'
            patched = bytearray(prepared.read_bytes())
            offset = data['grant_offset']
            self.assertEqual(patched[offset:offset+36], carrier.PLACEHOLDER.encode())
            patched[offset:offset+36] = grant.encode()
            personalized = root / 'personalized.tar'
            personalized.write_bytes(patched)
            with tarfile.open(personalized) as archive:
                members = archive.getmembers()
                self.assertEqual(len(members), 1)
                member = members[0]
                self.assertTrue(member.isfile())
                self.assertEqual(member.mode, 0o755)
                self.assertEqual(member.offset_data, 1536)
                self.assertEqual(member.pax_headers, {'SCHILY.xattr.' + carrier.LINUX_XATTR: grant})
                self.assertEqual(archive.extractfile(member).read(), content)
            self.assertEqual(artifact.read_bytes(), content)
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                carrier.package_linux_xattr(artifact, root / 'out', 'linux', '1.2.3')
            with self.assertRaisesRegex(ValueError, 'version'):
                carrier.package_linux_xattr(artifact, root / 'wrong-version', 'linux', '1.2.4')
            with self.assertRaisesRegex(ValueError, 'platform linux'):
                carrier.package_linux_xattr(artifact, root / 'wrong-platform', 'windows', '1.2.3')
            if sys.platform == 'linux':
                restored = root / 'restored'
                restored.mkdir()
                subprocess.run(['tar', '--xattrs', '-xf', str(personalized), '-C', str(restored)], check=True)
                executable = restored / member.name
                self.assertEqual(executable.read_bytes(), content)
                self.assertEqual(executable.stat().st_mode & 0o777, 0o755)
                renamed = restored / 'renamed.AppImage'
                executable.rename(renamed)
                self.assertEqual(os.getxattr(renamed, carrier.LINUX_XATTR), grant.encode())
                # Verify persistence from a fresh process, without in-memory state.
                received = subprocess.check_output([
                    sys.executable, '-c', 'import os,sys;sys.stdout.buffer.write(os.getxattr(sys.argv[1],sys.argv[2]))',
                    str(renamed), carrier.LINUX_XATTR])
                self.assertEqual(received, grant.encode())
                ordinary = root / 'without-xattrs'
                ordinary.mkdir()
                subprocess.run(['tar', '--no-xattrs', '-xf', str(personalized), '-C', str(ordinary)], check=True)
                self.assertNotIn(carrier.LINUX_XATTR, os.listxattr(ordinary / member.name))

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS signing tools")
    def test_signed_archive_metadata_and_overwrite_boundaries(self):
        with tempfile.TemporaryDirectory(prefix='screenpipe-carrier-test-') as tmp:
            root = Path(tmp)
            app = root / 'Fixture.app'
            executable = app / 'Contents/MacOS/Fixture'
            executable.parent.mkdir(parents=True)
            shutil.copyfile('/bin/echo', executable)
            executable.chmod(0o755)
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(dict(
                CFBundleIdentifier='com.screenpipe.carrier-fixture', CFBundleExecutable='Fixture',
                CFBundleName='Fixture', CFBundlePackageType='APPL', CFBundleShortVersionString='0.3.100')))
            subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
            architectures = subprocess.check_output(['lipo', '-archs', str(executable)]).decode()
            platform = 'macos-arm' if 'arm64' in architectures else 'macos-intel'
            output = root / 'output'
            archive, manifest = carrier.package(app, output, platform, '0.3.100')
            self.assertTrue(archive.is_file())
            self.assertTrue(manifest.is_file())
            # Packaging already verifies extraction, xattr preservation and the
            # actual extracted signature. Also prove it never mutates the input.
            attrs = subprocess.check_output(['xattr', str(app)]).decode()
            self.assertNotIn('com.apple.application-instance', attrs)
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                carrier.package(app, output, platform, '0.3.100')
            with self.assertRaisesRegex(ValueError, 'version'):
                carrier.package(app, root / 'wrong-version', platform, '0.3.101')

    def test_appimage_bytes_unchanged_and_metadata_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / 'screenpipe_1.2.3_amd64.AppImage'
            content = bytearray(1024)
            content[:6] = b'\x7fELF\x02\x01'
            content[8:11] = b'AI\x02'
            content[18] = 62
            artifact.write_bytes(content)
            artifact.chmod(0o755)
            prepared, manifest = carrier.package_filename(artifact, root / 'out', 'linux', '1.2.3')
            self.assertEqual(prepared.read_bytes(), content)
            self.assertEqual(artifact.read_bytes(), content)
            data = json.loads(manifest.read_text())
            self.assertEqual(data['sha256'], hashlib.sha256(content).hexdigest())
            self.assertEqual(data['carrier'], 'filename')
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                carrier.package_filename(artifact, root / 'out', 'linux', '1.2.3')
            with self.assertRaisesRegex(ValueError, 'version'):
                carrier.package_filename(artifact, root / 'bad-version', 'linux', '1.2.4')
            content[18] = 183
            artifact.write_bytes(content)
            with self.assertRaisesRegex(ValueError, 'x86_64'):
                carrier.package_filename(artifact, root / 'bad-arch', 'linux', '1.2.3')

    def test_windows_bytes_metadata_architecture_and_overwrite_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content = b'MZ' + bytes(1022)
            for platform, arch in [('windows', 'x64'), ('windows-arm', 'arm64')]:
                artifact = root / f'screenpipe_1.2.3_{arch}-setup.exe'
                artifact.write_bytes(content)
                output = root / platform
                metadata = dict(Status='Valid', ProductVersion='1.2.3', FileVersion='1.2.3')
                with mock.patch.object(carrier, 'windows_metadata', return_value=metadata):
                    prepared, manifest = carrier.package_filename(artifact, output, platform, '1.2.3')
                    self.assertEqual(prepared.name, 'screenpipe-attribution.exe')
                    self.assertEqual(prepared.read_bytes(), content)
                    data = json.loads(manifest.read_text())
                    self.assertEqual(data['sha256'], hashlib.sha256(content).hexdigest())
                    self.assertEqual(data['carrier'], 'filename')
                    with self.assertRaisesRegex(ValueError, 'overwrite'):
                        carrier.package_filename(artifact, output, platform, '1.2.3')
                wrong_arch = root / f'screenpipe_1.2.3_{"arm64" if arch == "x64" else "x64"}-setup.exe'
                wrong_arch.write_bytes(content)
                with self.assertRaisesRegex(ValueError, 'architecture'):
                    carrier.package_filename(wrong_arch, root / f'bad-{platform}', platform, '1.2.3')
                with mock.patch.object(carrier, 'windows_metadata', return_value={**metadata, 'Status': 'NotSigned'}):
                    with self.assertRaisesRegex(ValueError, 'Authenticode'):
                        carrier.package_filename(artifact, root / f'unsigned-{platform}', platform, '1.2.3')
                with mock.patch.object(carrier, 'windows_metadata', return_value={**metadata, 'ProductVersion': '1.2.4', 'FileVersion': '1.2.4'}):
                    with self.assertRaisesRegex(ValueError, 'version metadata'):
                        carrier.package_filename(artifact, root / f'version-{platform}', platform, '1.2.3')

    def test_windows_certificate_manifest_contract_for_both_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            placeholder_bytes = b'prefix' + carrier.PLACEHOLDER.encode() + b'suffix'
            for platform, arch in [('windows', 'x64'), ('windows-arm', 'arm64')]:
                artifact = root / f'screenpipe_1.2.3_{arch}-setup.exe'
                artifact.write_bytes(b'MZ' + bytes(128))
                output = root / f'certificate-{platform}'
                metadata = dict(Status='Valid', ProductVersion='1.2.3', FileVersion='1.2.3')
                with mock.patch.object(carrier, 'windows_metadata', return_value=metadata), \
                     mock.patch.object(carrier, '_prepare_windows_certificate',
                                       return_value=(placeholder_bytes, 6)):
                    prepared, manifest = carrier.package_windows_certificate(
                        artifact, output, platform, '1.2.3')
                data = json.loads(manifest.read_text())
                self.assertEqual(prepared.name, 'screenpipe-attribution-windows.exe')
                self.assertEqual(manifest.name, 'screenpipe-attribution-windows.json')
                self.assertEqual(data['schema'], 4)
                self.assertEqual(data['carrier'], 'windows-certificate')
                self.assertEqual(data['platform'], platform)
                self.assertEqual(data['patch'], dict(
                    offset=6, length=36, placeholder=carrier.PLACEHOLDER))
                self.assertEqual(data['certificate'], dict(
                    oid=carrier.WINDOWS_OID, critical=False,
                    marker=carrier.WINDOWS_MARKER.decode(), table_at_end=True))
                self.assertEqual(data['sha256'], hashlib.sha256(placeholder_bytes).hexdigest())

    @unittest.skipUnless(sys.platform == 'win32', 'requires Windows NSIS')
    def test_actual_nsis_filename_grant_fixture(self):
        makensis = shutil.which('makensis') or shutil.which('makensis.exe')
        self.assertIsNotNone(makensis, 'makensis is required for the Windows fixture')
        hooks = (Path(__file__).parents[1] / 'apps/screenpipe-app-tauri/src-tauri/windows/hooks.nsh').resolve()
        with tempfile.TemporaryDirectory(prefix='screenpipe-nsis-attribution-') as tmp:
            root = Path(tmp)
            fixture = root / 'fixture.nsi'
            fixture.write_text(
                '; screenpipe — AI that knows everything you\'ve seen, said, or heard\n'
                '; https://screenpipe.com\n'
                'Unicode true\nSilentInstall silent\nRequestExecutionLevel user\n'
                f'!include "{hooks}"\n'
                'Name "Screenpipe attribution fixture"\nOutFile "fixture.exe"\nInstallDir "$TEMP\\screenpipe-attribution-fixture"\n'
                'Section\nCreateDirectory "$INSTDIR"\nFileOpen $0 "$INSTDIR\\installed" w\nFileWrite $0 "ok"\nFileClose $0\n'
                '!insertmacro _SP_SaveAcquisitionGrant\nSectionEnd\n',
                encoding='utf-8')
            subprocess.run([makensis, '/V2', str(fixture)], cwd=root, check=True)

            # Exercise the real PowerShell adapter, including a path whose
            # spaces and metacharacters must remain data, never command text.
            metadata_fixture = root / 'fixture $ [attribution].exe'
            shutil.copyfile(root / 'fixture.exe', metadata_fixture)
            self.assertEqual(carrier.windows_metadata(metadata_fixture)['Status'], 'NotSigned')

            first = '12345678-1234-4234-8234-123456789012'
            second = 'abcdefab-cdef-4abc-9def-abcdefabcdef'

            def install(filename, directory, zone_identifier=None):
                installer = root / filename
                shutil.copyfile(root / 'fixture.exe', installer)
                if zone_identifier is not None:
                    Path(str(installer) + ':Zone.Identifier').write_text(
                        zone_identifier, encoding='ascii', newline='')
                    with Path(str(installer) + ':Zone.Identifier').open(
                            encoding='ascii', newline='') as stream:
                        self.assertEqual(stream.read(), zone_identifier)
                subprocess.run([str(installer), '/S', f'/D={directory}'], check=True)
                self.assertEqual((directory / 'installed').read_text(), 'ok')

            valid_dir = root / 'valid'
            install(f'screenpipe-{first}.exe', valid_dir)
            self.assertEqual((valid_dir / 'acquisition-grant').read_text(), first)
            install(f'screenpipe-{second}.exe', valid_dir)
            self.assertEqual((valid_dir / 'acquisition-grant').read_text(), first)

            ads = ('[ZoneTransfer]\r\nZoneId=3\r\n'
                   f'HostUrl=https://downloads.test/download/ticket/screenpipe-{second}.exe\r\n')
            ads_dir = root / 'ads-renamed'
            install('renamed.exe', ads_dir, ads)
            self.assertTrue((ads_dir / 'acquisition-grant').is_file(),
                            [(p.name, p.read_text(errors='replace')) for p in ads_dir.iterdir()])
            self.assertEqual((ads_dir / 'acquisition-grant').read_text(), second)
            # A valid browser origin is preferred over a conflicting legacy
            # filename, while a previous install remains first-grant wins.
            conflict_dir = root / 'ads-conflict'
            install(f'screenpipe-{first}.exe', conflict_dir, ads)
            self.assertEqual((conflict_dir / 'acquisition-grant').read_text(), second)
            install('renamed-again.exe', conflict_dir,
                    ads.replace(second, '11111111-1111-4111-8111-111111111111'))
            self.assertEqual((conflict_dir / 'acquisition-grant').read_text(), second)

            host_prefix = 'HostUrl=https://downloads.test/download/'
            host_suffix = f'/screenpipe-{second}.exe'
            for logical_length, newline in [(1022, ''), (1023, ''), (1023, '\r\n')]:
                boundary_ads = ('[ZoneTransfer]\r\n' + host_prefix
                                + ('x' * (logical_length - len(host_prefix) - len(host_suffix)))
                                + host_suffix + newline)
                directory = root / f'ads-boundary-{logical_length}-{len(newline)}'
                install('renamed.exe', directory, boundary_ads)
                self.assertEqual((directory / 'acquisition-grant').read_text(), second)
                self.assertFalse((directory / 'acquisition-grant-diagnostic').exists())

            # An unrelated field may span as many fixed NSIS reads as the ADS
            # actually contains. It must not hide a later complete HostUrl.
            unrelated = ('[ZoneTransfer]\r\nReferrerUrl=https://referrer.test/'
                         + ('r' * 2500) + '\r\n' + host_prefix + host_suffix + '\r\n')
            unrelated_dir = root / 'ads-overlong-referrer'
            install('renamed.exe', unrelated_dir, unrelated)
            self.assertEqual((unrelated_dir / 'acquisition-grant').read_text(), second)
            self.assertFalse((unrelated_dir / 'acquisition-grant-diagnostic').exists())

            overflow_length = 1024
            overflow_ads = ('[ZoneTransfer]\r\n' + host_prefix
                            + ('x' * (overflow_length - len(host_prefix) - len(host_suffix)))
                            + host_suffix + '\r\n')
            overflow_dir = root / 'ads-host-overflow'
            install(f'screenpipe-{first}.exe', overflow_dir, overflow_ads)
            self.assertEqual((overflow_dir / 'acquisition-grant').read_text(), first)
            self.assertEqual(
                (overflow_dir / 'acquisition-grant-diagnostic').read_text(),
                'v1;host-url-overflow;actual-chars=1024;threshold-chars=1023;'
                'fallback=filename;persistence=saved')

            fallback_cases = [
                '[ZoneTransfer]\r\nZoneId=3\r\n',
                '[ZoneTransfer]\r\nHostUrl=http://downloads.test/'
                f'screenpipe-{second}.exe\r\n',
                '[ZoneTransfer]\r\nHostUrl=https://downloads.test/?next=/'
                f'screenpipe-{second}.exe\r\n',
                '[ZoneTransfer]\r\nHostUrl=https://downloads.test/download/'
                f'screenpipe-{second}.exe\r\nHostUrl=https://downloads.test/download/'
                f'screenpipe-{second}.exe\r\n',
                '[Other]\r\nHostUrl=https://downloads.test/download/'
                f'screenpipe-{second}.exe\r\n',
                '[ZoneTransfer]\r\nHostUrl=https://downloads.test/download/'
                'screenpipe-12345678-1234-4234-C234-123456789012.exe\r\n',
                '[ZoneTransfer]\r\nHostUrl=https://downloads.test/download/'
                'screenpipe-ABCDEFAB-cdef-4abc-9def-abcdefabcdef.exe\r\n',
                '[ZoneTransfer]\r\nHostUrl=https://downloads.test/download/'
                'screenpipe-abcdefab-cdef-4abc-Bdef-abcdefabcdef.exe\r\n',
            ]
            for index, malformed_ads in enumerate(fallback_cases):
                directory = root / f'ads-fallback-{index}'
                install(f'screenpipe-{first}.exe', directory, malformed_ads)
                self.assertEqual((directory / 'acquisition-grant').read_text(), first)
                diagnostic = directory / 'acquisition-grant-diagnostic'
                if index in {1, 2, 3, 5, 6, 7}:
                    cause = ('duplicate-host-url' if index == 3 else 'malformed-host-url')
                    self.assertEqual(
                        diagnostic.read_text(),
                        f'v1;{cause};fallback=filename;persistence=saved')
                    self.assertNotIn(first, diagnostic.read_text())
                    self.assertNotIn(second, diagnostic.read_text())
                else:
                    self.assertFalse(diagnostic.exists())
            for index, name in enumerate([
                f'screenpipe-{carrier.PLACEHOLDER}.exe',
                'screenpipe-12345678-1234-4234-7234-123456789012.exe',
                'screenpipe-12345678-1234-4234-C234-123456789012.exe',
                'screenpipe-ABCDEFAB-cdef-4abc-9def-abcdefabcdef.exe',
                'screenpipe-abcdefab-cdef-4abc-Bdef-abcdefabcdef.exe',
                'screenpipe.exe',
            ]):
                directory = root / f'invalid-{index}'
                install(name, directory)
                self.assertFalse((directory / 'acquisition-grant').exists())


if __name__ == '__main__':
    unittest.main()
