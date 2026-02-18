/**
 * Built-in Templates
 * 内置的 ComfyUI workflow 模板（带占位符）
 */

const BuiltinTemplates = [
  {
    id: 'builtin_txt2img_basic',
    name: '文生图 (基础版)',
    description: '基础文生图 workflow，支持自定义提示词、尺寸、采样参数',
    isBuiltin: true,
    defaults: {
      width: 512,
      height: 768,
      batch_size: 1,
      seed: -1,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: 1,
      prompt: 'masterpiece, best quality, 1girl, solo, standing',
      negative_prompt: 'worst quality, low quality, bad anatomy, bad hands, text, error, missing fingers'
    },
    workflow: {
      "8": {
        "inputs": {
          "samples": ["19", 0],
          "vae": ["15", 0]
        },
        "class_type": "VAEDecode",
        "_meta": {
          "title": "VAE解码"
        }
      },
      "11": {
        "inputs": {
          "text": "{{prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (正向)"
        }
      },
      "12": {
        "inputs": {
          "text": "{{negative_prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (负面)"
        }
      },
      "15": {
        "inputs": {
          "vae_name": "qwen_image_vae.safetensors"
        },
        "class_type": "VAELoader",
        "_meta": {
          "title": "VAE加载器"
        }
      },
      "19": {
        "inputs": {
          "seed": {{seed}},
          "steps": {{steps}},
          "cfg": {{cfg}},
          "sampler_name": "{{sampler_name}}",
          "scheduler": "{{scheduler}}",
          "denoise": {{denoise}},
          "model": ["44", 0],
          "positive": ["11", 0],
          "negative": ["12", 0],
          "latent_image": ["48", 0]
        },
        "class_type": "KSampler",
        "_meta": {
          "title": "K采样器"
        }
      },
      "44": {
        "inputs": {
          "unet_name": "anima-preview.safetensors",
          "weight_dtype": "default"
        },
        "class_type": "UNETLoader",
        "_meta": {
          "title": "UNET加载器"
        }
      },
      "45": {
        "inputs": {
          "clip_name": "qwen_3_06b_base.safetensors",
          "type": "stable_diffusion",
          "device": "default"
        },
        "class_type": "CLIPLoader",
        "_meta": {
          "title": "CLIP加载器"
        }
      },
      "48": {
        "inputs": {
          "width": {{width}},
          "height": {{height}},
          "batch_size": {{batch_size}}
        },
        "class_type": "EmptyLatentImage",
        "_meta": {
          "title": "空Latent"
        }
      },
      "50": {
        "inputs": {
          "filename_prefix": "ComfyUI",
          "images": ["8", 0]
        },
        "class_type": "SaveImage",
        "_meta": {
          "title": "保存图像"
        }
      }
    }
  },

  {
    id: 'builtin_txt2img_sdxl',
    name: '文生图 (SDXL 1024)',
    description: 'SDXL 专用 workflow，默认 1024x1024',
    isBuiltin: true,
    defaults: {
      width: 1024,
      height: 1024,
      batch_size: 1,
      seed: -1,
      steps: 30,
      cfg: 7,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      prompt: 'masterpiece, best quality, highly detailed, 8k uhd',
      negative_prompt: 'worst quality, low quality, blurry, jpeg artifacts'
    },
    workflow: {
      "8": {
        "inputs": {
          "samples": ["19", 0],
          "vae": ["15", 0]
        },
        "class_type": "VAEDecode",
        "_meta": {
          "title": "VAE解码"
        }
      },
      "11": {
        "inputs": {
          "text": "{{prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (正向)"
        }
      },
      "12": {
        "inputs": {
          "text": "{{negative_prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (负面)"
        }
      },
      "15": {
        "inputs": {
          "vae_name": "sdxl_vae.safetensors"
        },
        "class_type": "VAELoader",
        "_meta": {
          "title": "VAE加载器"
        }
      },
      "19": {
        "inputs": {
          "seed": {{seed}},
          "steps": {{steps}},
          "cfg": {{cfg}},
          "sampler_name": "{{sampler_name}}",
          "scheduler": "{{scheduler}}",
          "denoise": {{denoise}},
          "model": ["44", 0],
          "positive": ["11", 0],
          "negative": ["12", 0],
          "latent_image": ["48", 0]
        },
        "class_type": "KSampler",
        "_meta": {
          "title": "K采样器"
        }
      },
      "44": {
        "inputs": {
          "unet_name": "sdxl_base.safetensors",
          "weight_dtype": "default"
        },
        "class_type": "UNETLoader",
        "_meta": {
          "title": "UNET加载器"
        }
      },
      "45": {
        "inputs": {
          "clip_name": "sdxl_clip.safetensors",
          "type": "stable_diffusion",
          "device": "default"
        },
        "class_type": "CLIPLoader",
        "_meta": {
          "title": "CLIP加载器"
        }
      },
      "48": {
        "inputs": {
          "width": {{width}},
          "height": {{height}},
          "batch_size": {{batch_size}}
        },
        "class_type": "EmptyLatentImage",
        "_meta": {
          "title": "空Latent"
        }
      },
      "50": {
        "inputs": {
          "filename_prefix": "ComfyUI",
          "images": ["8", 0]
        },
        "class_type": "SaveImage",
        "_meta": {
          "title": "保存图像"
        }
      }
    }
  },

  {
    id: 'builtin_img2img',
    name: '图生图 (img2img)',
    description: '基于输入图片的重绘 workflow，支持调整重绘幅度',
    isBuiltin: true,
    defaults: {
      width: 512,
      height: 768,
      batch_size: 1,
      seed: -1,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: 0.75,
      prompt: 'masterpiece, best quality, detailed',
      negative_prompt: 'worst quality, low quality, bad anatomy',
      input_image: 'input.png'
    },
    workflow: {
      "3": {
        "inputs": {
          "seed": {{seed}},
          "steps": {{steps}},
          "cfg": {{cfg}},
          "sampler_name": "{{sampler_name}}",
          "scheduler": "{{scheduler}}",
          "denoise": {{denoise}},
          "model": ["44", 0],
          "positive": ["11", 0],
          "negative": ["12", 0],
          "latent_image": ["13", 0]
        },
        "class_type": "KSampler",
        "_meta": {
          "title": "K采样器"
        }
      },
      "8": {
        "inputs": {
          "samples": ["3", 0],
          "vae": ["15", 0]
        },
        "class_type": "VAEDecode",
        "_meta": {
          "title": "VAE解码"
        }
      },
      "11": {
        "inputs": {
          "text": "{{prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (正向)"
        }
      },
      "12": {
        "inputs": {
          "text": "{{negative_prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (负面)"
        }
      },
      "13": {
        "inputs": {
          "pixels": ["20", 0],
          "vae": ["15", 0]
        },
        "class_type": "VAEEncode",
        "_meta": {
          "title": "VAE编码"
        }
      },
      "15": {
        "inputs": {
          "vae_name": "qwen_image_vae.safetensors"
        },
        "class_type": "VAELoader",
        "_meta": {
          "title": "VAE加载器"
        }
      },
      "20": {
        "inputs": {
          "image": "{{input_image}}",
          "upload": "image"
        },
        "class_type": "LoadImage",
        "_meta": {
          "title": "加载图像"
        }
      },
      "44": {
        "inputs": {
          "unet_name": "anima-preview.safetensors",
          "weight_dtype": "default"
        },
        "class_type": "UNETLoader",
        "_meta": {
          "title": "UNET加载器"
        }
      },
      "45": {
        "inputs": {
          "clip_name": "qwen_3_06b_base.safetensors",
          "type": "stable_diffusion",
          "device": "default"
        },
        "class_type": "CLIPLoader",
        "_meta": {
          "title": "CLIP加载器"
        }
      },
      "50": {
        "inputs": {
          "filename_prefix": "ComfyUI",
          "images": ["8", 0]
        },
        "class_type": "SaveImage",
        "_meta": {
          "title": "保存图像"
        }
      }
    }
  },

  {
    id: 'anima_preview_v1',
    name: 'Anima Preview V1',
    description: '基于 anima-preview.safetensors 的文生图 workflow（原始版本）',
    isBuiltin: true,
    defaults: {
      width: 896,
      height: 1152,
      batch_size: 1,
      seed: -1,
      steps: 32,
      cfg: 4.2,
      sampler_name: 'euler_ancestral',
      scheduler: 'simple',
      denoise: 1,
      prompt: 'masterpiece, best quality, score_7, nsfw, explicit, good quality, newest, recent, very aesthetic, absurdres, highres, uncensored.\nkiriko (overwatch), overwatch.\nblender_(medium), 3d.\nkiriko in overwatch holding weapon with breasts expose, in a dark place, 3d render style.',
      negative_prompt: 'worst quality, bad quality, low quality, score_1, score_2, score_3, old, early, oldest, jpeg artifacts, watermark, censored, bar censor, unfinished, signature, copyright name, artist name, patreon username, patreon logo, twitter username, web address, extra limbs, fused, extra digits, bad anatomy,'
    },
    workflow: {
      "8": {
        "inputs": {
          "samples": ["19", 0],
          "vae": ["15", 0]
        },
        "class_type": "VAEDecode",
        "_meta": {
          "title": "VAE解码"
        }
      },
      "11": {
        "inputs": {
          "text": "{{prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (正向)"
        }
      },
      "12": {
        "inputs": {
          "text": "{{negative_prompt}}",
          "clip": ["45", 0]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器 (负面)"
        }
      },
      "15": {
        "inputs": {
          "vae_name": "qwen_image_vae.safetensors"
        },
        "class_type": "VAELoader",
        "_meta": {
          "title": "VAE加载器"
        }
      },
      "19": {
        "inputs": {
          "seed": {{seed}},
          "steps": {{steps}},
          "cfg": {{cfg}},
          "sampler_name": "{{sampler_name}}",
          "scheduler": "{{scheduler}}",
          "denoise": {{denoise}},
          "model": ["44", 0],
          "positive": ["11", 0],
          "negative": ["12", 0],
          "latent_image": ["48", 0]
        },
        "class_type": "KSampler",
        "_meta": {
          "title": "K采样器"
        }
      },
      "44": {
        "inputs": {
          "unet_name": "anima-preview.safetensors",
          "weight_dtype": "default"
        },
        "class_type": "UNETLoader",
        "_meta": {
          "title": "UNET加载器"
        }
      },
      "45": {
        "inputs": {
          "clip_name": "qwen_3_06b_base.safetensors",
          "type": "stable_diffusion",
          "device": "default"
        },
        "class_type": "CLIPLoader",
        "_meta": {
          "title": "CLIP加载器"
        }
      },
      "48": {
        "inputs": {
          "width": {{width}},
          "height": {{height}},
          "batch_size": {{batch_size}}
        },
        "class_type": "EmptyLatentImage",
        "_meta": {
          "title": "空Latent"
        }
      },
      "50": {
        "inputs": {
          "filename_prefix": "ComfyUI",
          "images": ["8", 0]
        },
        "class_type": "SaveImage",
        "_meta": {
          "title": "保存图像"
        }
      }
    }
  }
];

// 导出到全局
window.BuiltinTemplates = BuiltinTemplates;
