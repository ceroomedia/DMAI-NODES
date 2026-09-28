import tempfile
import json
from pathlib import Path
import unittest
import zipfile
import numpy as np
from PIL import Image
from dmai_nodes.gallery import GalleryStore


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store=GalleryStore(self.temp.name)
        self.pixels=np.array([[[[0.,0.5,1.]]*4]*3],dtype=np.float32)

    def save(self,gallery="test"):
        return self.store.save(self.pixels,gallery)[1][0]

    def test_original_exact_png_and_durable_history(self):
        item=self.save()
        row,path=self.store.image(item["id"])
        self.assertEqual(Image.open(path).getpixel((0,0)),(0,128,255))
        self.assertEqual(GalleryStore(self.temp.name).list("test")["total"],1)
        self.assertNotIn("relative_path",item)

    def test_execution_ui_payload_contains_a_list_wrapped_gallery_page(self):
        payload, saved = self.store.save(self.pixels, "test")
        # These values are delivered by Comfy's executed event and history API;
        # the Gallery controller consumes the first object in dmai_gallery.
        transported = json.loads(json.dumps(payload))
        self.assertIsInstance(transported["dmai_gallery"], list)
        self.assertEqual(len(transported["dmai_gallery"]), 1)
        page = transported["dmai_gallery"][0]
        self.assertEqual(page["gallery_id"], "test")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["id"], saved[0]["id"])
        self.assertEqual(page["items"][0]["filename"], saved[0]["filename"])
        # Native media fields create an additional Comfy preview beneath the
        # custom Gallery. Originals remain accessible through custom metadata.
        self.assertNotIn("images", transported)

    def test_exact_selected_files_and_crc(self):
        a,b,c=self.save(),self.save(),self.save()
        path=self.store.create_zip("test",{"ids":[c["id"],a["id"]]})
        try:
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(archive.namelist(),[c["filename"],a["filename"]])
                self.assertIsNone(archive.testzip())
                for item in (a,c):
                    self.assertEqual(archive.read(item["filename"]),self.store.image(item["id"])[1].read_bytes())
        finally:path.unlink()

    def test_select_all_uses_snapshot_excludes_later_arrival(self):
        first=self.save()
        page=self.store.list("test")
        self.save()
        path=self.store.create_zip("test",{"all":True,"before":page["watermark"]})
        try:
            with zipfile.ZipFile(path) as archive:self.assertEqual(archive.namelist(),[first["filename"]])
        finally:path.unlink()
        self.assertEqual(self.store.list("test",before=page["watermark"])["total"],1)

    def test_missing_cross_gallery_duplicate_empty_and_path_rejected(self):
        first=self.save()
        other=self.save("other")
        for selection in ({"ids":[]},{"ids":[first["id"],first["id"]]},{"all":True},{"ids":[other["id"]]},{"ids":["../file"]}):
            with self.assertRaises((ValueError,FileNotFoundError)):self.store.create_zip("test",selection)
        with self.assertRaises(ValueError):self.store.list("../other")
        with self.assertRaises(ValueError):self.store.path("../other.png")
        self.store.image(first["id"])[1].unlink()
        with self.assertRaises(FileNotFoundError):self.store.create_zip("test",{"ids":[first["id"]]})

    def test_nonfinite_pixels_and_bad_pagination(self):
        with self.assertRaises(ValueError):self.store.save(np.full((1,2,2,3),np.nan),"test")
        for value in (-1,True,"a"):
            with self.assertRaises(ValueError):self.store.list("test",offset=value)

if __name__=="__main__":unittest.main()
