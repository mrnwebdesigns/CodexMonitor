from pathlib import Path
import plistlib
import tempfile
import unittest

from browser_lab_runtime import bundle


class BrowserLabBundleTests(unittest.TestCase):
    def test_refuses_working_app_identifier_before_modifying_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "Working.app"
            contents = app / "Contents"
            framework = contents / "Frameworks/Chromium Embedded Framework.framework"
            framework.mkdir(parents=True)
            marker = framework / "keep.txt"
            marker.write_text("working app")
            (contents / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.mrnwebdesigns.codexmonitor.local",
            }))
            with self.assertRaises(SystemExit):
                bundle(root, root / "cef", app, "com.mrnwebdesigns.codexmonitor.browserlab", "0.7.68")
            self.assertEqual(marker.read_text(), "working app")


if __name__ == "__main__":
    unittest.main()
