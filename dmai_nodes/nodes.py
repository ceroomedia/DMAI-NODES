"""Native ComfyUI V3 nodes sharing the same UI and headless contracts."""
import json
from comfy_api.latest import io
from .engine import execute_engine, validate_request
from .lora import parse_manifest, fingerprint_manifest
from .gallery import default_store, gallery_id

PromptPort = io.Custom("DMAI_PROMPT")
LoraPort = io.Custom("DMAI_LORA_STACK")
ReportPort = io.Custom("DMAI_REPORT")
DEFAULT_PROMPT = {"schema_version":1,"prompt":"","negative_prompt":"","width":832,"height":1024,"count":4}
DEFAULT_LORAS = {"schema_version":1,"entries":[]}
DEFAULT_ENGINE = {"schema_version":1,"profile_id":"krea2-turbo","mode":"manual","preset_id":"",
    "settings":{"steps":8,"cfg":1.1,"sampler":"euler","scheduler":"beta","denoise":1,"enhancer":"none"},
    "seed":481516,"models":{"diffusion_model":"krea2_turbo_fp8.safetensors","text_encoder":"qwen3vl_4b_fp8_scaled.safetensors","vae":"wan_2.1_vae.safetensors","checkpoint":""},"presets":[]}


def json_config(value):
    if not isinstance(value,str) or len(value.encode("utf-8")) > 128*1024:
        raise ValueError("Configuration must be JSON text up to 128 KiB.")
    from .presets import read_json
    return read_json(value)


class DMAINodesPrompter(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAINodesPrompter",display_name="DMAI Prompter",category="DMAI NODES",
            description="Prompt, dimensions and image count. Optional text input is prepended to local text.",
            inputs=[io.String.Input("config_json",default=json.dumps(DEFAULT_PROMPT),multiline=True,socketless=True),
                    io.String.Input("text",optional=True,force_input=True,advanced=True,tooltip="Optional source text, followed by the local prompt.")],
            outputs=[PromptPort.Output(display_name="request")])

    @classmethod
    def execute(cls,config_json,text=None):
        request=json_config(config_json)
        if text is not None:
            if not isinstance(text,str) or not isinstance(request,dict) or not isinstance(request.get("prompt"),str):
                raise ValueError("Connected text and prompt must be strings.")
            request["prompt"]="\n".join(part for part in (text.strip(),request["prompt"].strip()) if part)
        return io.NodeOutput(validate_request(request))


class DMAILoRAStack(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAILoRAStack",display_name="DMAI LoRA Loader",category="DMAI NODES",
            description="Ordered LoRA recipe. Weights are applied inside the Generation Engine before encoding.",
            inputs=[io.String.Input("manifest_json",default=json.dumps(DEFAULT_LORAS),multiline=True,socketless=True)],
            outputs=[LoraPort.Output(display_name="loras")])

    @classmethod
    def execute(cls,manifest_json):
        return io.NodeOutput(parse_manifest(manifest_json))

    @classmethod
    def fingerprint_inputs(cls,manifest_json):
        return fingerprint_manifest(manifest_json)


class DMAIGenerationEngine(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAIGenerationEngine",display_name="DMAI Generation Engine",category="DMAI NODES",
            description="Generate with registered model profiles, ordered LoRAs and validated sampling presets.",
            inputs=[PromptPort.Input("request"),io.String.Input("config_json",default=json.dumps(DEFAULT_ENGINE),multiline=True,socketless=True),LoraPort.Input("loras",optional=True),
                    io.Custom("SAMPLER").Input("sampler",optional=True,advanced=True),io.Custom("SIGMAS").Input("sigmas",optional=True,advanced=True),
                    io.Model.Input("model",optional=True,advanced=True),io.Clip.Input("clip",optional=True,advanced=True),io.Vae.Input("vae",optional=True,advanced=True),
                    io.Latent.Input("latent",optional=True,advanced=True),
                    io.Conditioning.Input("positive",optional=True,advanced=True),io.Conditioning.Input("negative",optional=True,advanced=True)],
            outputs=[io.Image.Output(display_name="images"),ReportPort.Output(display_name="report")],
            hidden=[io.Hidden.unique_id])

    @classmethod
    def execute(cls,request,config_json,loras=None,sampler=None,sigmas=None,model=None,clip=None,vae=None,latent=None,positive=None,negative=None):
        images,report=execute_engine(request,config_json,loras,sampler=sampler,sigmas=sigmas,model=model,clip=clip,vae=vae,latent=latent,positive=positive,negative=negative,node_id=getattr(cls.hidden,"unique_id",None))
        return io.NodeOutput(images,report,ui={"dmai_report":[report]})

    @classmethod
    def fingerprint_inputs(cls,config_json,**kwargs):
        from .engine import fingerprint_engine
        return fingerprint_engine(config_json,model=kwargs.get("model"),clip=kwargs.get("clip"),vae=kwargs.get("vae"))


class DMAIGallery(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAIGallery",display_name="DMAI Gallery",category="DMAI NODES",is_output_node=True,
            description="Persistent PNG originals, selection, individual downloads and ZIP export.",
            inputs=[io.Image.Input("images"),io.String.Input("gallery_id",default="",socketless=True),ReportPort.Input("report",optional=True)],
            outputs=[io.Image.Output(display_name="images")],hidden=[io.Hidden.prompt,io.Hidden.extra_pnginfo])

    @classmethod
    def execute(cls,images,gallery_id="",report=None):
        payload,_=default_store().save(images,gallery_id,report,cls.hidden.prompt,cls.hidden.extra_pnginfo)
        return io.NodeOutput(images,ui=payload)


class DMAIKreaEnhancer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAIKreaEnhancer",display_name="DMAI Krea Enhancer",category="DMAI NODES/Advanced",
            description="Krea-only model enhancement using the separately installed Krea2T Enhancer. Never applies to other model families.",
            inputs=[io.Model.Input("model"),io.Boolean.Input("enabled",default=True),
                    io.Float.Input("strength",default=1.0,min=0.0,max=2.0,step=0.05),
                    io.Float.Input("text_scale",default=1.0,min=0.25,max=4.0,step=0.05)],
            outputs=[io.Model.Output(display_name="model")])

    @classmethod
    def execute(cls,model,enabled=True,strength=1.0,text_scale=1.0):
        if not enabled:return io.NodeOutput(model)
        from .engine import apply_krea_enhancer
        return io.NodeOutput(apply_krea_enhancer(model,strength=strength,text_scale=text_scale))


class DMAIVAEEncode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAIVAEEncode",display_name="DMAI VAE Encode",category="DMAI NODES/Advanced",
            description="Encode images with the supplied VAE. Connect the latent output to the Engine's advanced latent input.",
            inputs=[io.Image.Input("images"),io.Vae.Input("vae")],outputs=[io.Latent.Output(display_name="latent")])

    @classmethod
    def execute(cls,images,vae):
        from nodes import VAEEncode
        return io.NodeOutput(VAEEncode().encode(vae,images)[0])


class DMAIVAEDecode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="DMAIVAEDecode",display_name="DMAI VAE Decode",category="DMAI NODES/Advanced",
            description="Decode a latent with its matching VAE. Compatible with external sampler workflows.",
            inputs=[io.Latent.Input("latent"),io.Vae.Input("vae")],outputs=[io.Image.Output(display_name="images")])

    @classmethod
    def execute(cls,latent,vae):
        from nodes import VAEDecode
        return io.NodeOutput(VAEDecode().decode(vae,latent)[0])


NODE_CLASSES=[DMAINodesPrompter,DMAILoRAStack,DMAIGenerationEngine,DMAIGallery,DMAIKreaEnhancer,DMAIVAEEncode,DMAIVAEDecode]
