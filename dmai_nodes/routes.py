"""Local Comfy routes: catalogs, preset validation and owned gallery exports."""
from __future__ import annotations
import asyncio
from functools import wraps
from io import BytesIO
import json
import logging
from aiohttp import web
from PIL import Image
from . import __version__
from .gallery import API, default_store

LOG = logging.getLogger(__name__)
_registered = False


def envelope(handler):
    @wraps(handler)
    async def wrapped(request):
        try:
            return await handler(request)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            return web.json_response({"ok":False,"error":{"code":"invalid_request","message":str(error)}}, status=400)
        except FileNotFoundError as error:
            return web.json_response({"ok":False,"error":{"code":"not_found","message":str(error)}}, status=404)
        except web.HTTPException:
            raise
        except Exception:
            LOG.exception("DMAI NODES request failed")
            return web.json_response({"ok":False,"error":{"code":"server_error","message":"The request failed. Check the ComfyUI console."}}, status=500)
    return wrapped


def success(data):
    return web.json_response({"ok":True,"data":data})


async def body(request):
    data = bytearray()
    async for chunk in request.content.iter_chunked(16384):
        data.extend(chunk)
        if len(data) > 128 * 1024:
            raise ValueError("Request exceeds 128 KiB.")
    from .presets import read_json
    return read_json(data.decode("utf-8"))


def bootstrap():
    import folder_paths
    import comfy.samplers
    from .lora import list_loras
    from .profiles import get_profiles
    from .presets import get_builtin_presets
    def inventory(name):
        return sorted({item.replace("\\", "/") for item in folder_paths.get_filename_list(name)})
    return {"version":__version__,"profiles":get_profiles(),"presets":get_builtin_presets(),
            "models":{key:inventory(category) for key,category in (("diffusion_models","diffusion_models"),("text_encoders","text_encoders"),("vae","vae"),("checkpoints","checkpoints"))},
            "loras":list_loras(),"samplers":list(comfy.samplers.KSampler.SAMPLERS),
            "schedulers":list(comfy.samplers.KSampler.SCHEDULERS)}


def register_routes():
    global _registered
    if _registered:
        return
    from server import PromptServer
    routes = PromptServer.instance.routes

    @routes.get(f"{API}/health")
    async def health(request):
        return success({"version":__version__,"nodes":7,"api_workflow":True,"remote_auth":False})

    @routes.get(f"{API}/bootstrap")
    @envelope
    async def catalog(request):
        return success(await asyncio.to_thread(bootstrap))

    @routes.post(f"{API}/presets/validate")
    @envelope
    async def validate_presets(request):
        from .presets import parse_preset_file
        data = await body(request)
        return success({"presets":parse_preset_file(data)})

    @routes.get(f"{API}/galleries/{{gallery_id}}")
    @envelope
    async def history(request):
        query = request.query
        def read():
            return default_store().list(request.match_info["gallery_id"],query.get("offset",0),query.get("limit",60),query.get("before"))
        return success(await asyncio.to_thread(read))

    @routes.get(f"{API}/images/{{image_id}}")
    @envelope
    async def original(request):
        row,path = await asyncio.to_thread(lambda:default_store().image(request.match_info["image_id"]))
        headers = {"X-Content-Type-Options":"nosniff","Cache-Control":"private, max-age=3600"}
        if request.query.get("thumbnail") == "1" and request.query.get("download") != "1":
            def thumbnail():
                with Image.open(path) as img:
                    img.thumbnail((384,384))
                    stream=BytesIO()
                    img.convert("RGB").save(stream,"JPEG",quality=85)
                    return stream.getvalue()
            return web.Response(body=await asyncio.to_thread(thumbnail),content_type="image/jpeg",headers=headers)
        if request.query.get("download") == "1":
            headers["Content-Disposition"] = f'attachment; filename="{row["filename"]}"'
        return web.FileResponse(path,headers=headers)

    @routes.post(f"{API}/galleries/{{gallery_id}}/zip")
    @envelope
    async def archive(request):
        selection = await body(request)
        path = await asyncio.to_thread(lambda:default_store().create_zip(request.match_info["gallery_id"],selection))
        try:
            response = web.StreamResponse(headers={"Content-Type":"application/zip","Content-Disposition":'attachment; filename="DMAI-NODES-images.zip"',"Content-Length":str(path.stat().st_size),"X-Content-Type-Options":"nosniff"})
            await response.prepare(request)
            with path.open("rb") as source:
                while chunk := await asyncio.to_thread(source.read,256*1024):
                    await response.write(chunk)
            await response.write_eof()
            return response
        finally:
            path.unlink(missing_ok=True)

    _registered = True
