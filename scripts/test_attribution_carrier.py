# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Local attribution-carrier packaging regressions; never publish artifacts."""
import importlib.util
import hashlib
import json
import sys
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('carrier', Path(__file__).with_name('package-attribution-carrier.py'))
carrier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(carrier)


class CarrierTest(unittest.TestCase):
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

            def install(filename, directory):
                installer = root / filename
                shutil.copyfile(root / 'fixture.exe', installer)
                subprocess.run([str(installer), '/S', f'/D={directory}'], check=True)
                self.assertEqual((directory / 'installed').read_text(), 'ok')

            valid_dir = root / 'valid'
            install(f'screenpipe-{first}.exe', valid_dir)
            self.assertEqual((valid_dir / 'acquisition-grant').read_text(), first)
            install(f'screenpipe-{second}.exe', valid_dir)
            self.assertEqual((valid_dir / 'acquisition-grant').read_text(), first)
            for index, name in enumerate([
                f'screenpipe-{carrier.PLACEHOLDER}.exe',
                'screenpipe-12345678-1234-4234-7234-123456789012.exe',
                'screenpipe-12345678-1234-4234-C234-123456789012.exe',
                'screenpipe.exe',
            ]):
                directory = root / f'invalid-{index}'
                install(name, directory)
                self.assertFalse((directory / 'acquisition-grant').exists())


if __name__ == '__main__':
    unittest.main()
