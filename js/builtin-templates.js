/**
 * Built-in Templates
 * 内置的 ComfyUI workflow 模板（带占位符）
 *
 * 约定：为了保证 workflow 文本可被 JSON.parse，所有占位符都必须出现在 JSON 字符串中。
 * 例如："seed": "{{seed}}"，运行时再按占位符类型替换为 number。
 */

const BuiltinTemplates = [
  {
    id: 'anima_priview_v1',
    schemaVersion: 2,
    name: 'anima_priview_v1',
    description: '基于 ComfyUI_temp_pabtb_00004_ (2).json 的文生图 workflow（anima-preview.safetensors）',
    isBuiltin: true,
    defaults: {
      width: 896,
      height: 1152,
      batch_size: 1,
      seed: 1057109426240887,
      steps: 32,
      cfg: 4.2,
      sampler_name: 'euler_ancestral',
      scheduler: 'simple',
      denoise: 1,
      prompt: 'masterpiece, best quality, score_7, nsfw, explicit, good quality, newest, recent, very aesthetic, absurdres, highres, uncensored.\nkiriko (overwatch), overwatch.\nblender_(medium), 3d.\nkiriko in overwatch holding weapon with breasts expose, in a dark place, 3d render style.',
      negative_prompt: 'worst quality, bad quality, low quality, score_1, score_2, score_3, old, early, oldest, jpeg artifacts, watermark, censored, bar censor, unfinished, signature, copyright name, artist name, patreon username, patreon logo, twitter username, web address, extra limbs, fused, extra digits, bad anatomy,'
    },
    editor: {
      profile: 'txt2img-lora-v1',
      roles: {
        modelLoader: {
          nodeId: '44',
          outputIndex: 0,
          filenameInput: 'unet_name',
          label: 'UNET 模型'
        },
        clipLoader: {
          nodeId: '45',
          outputIndex: 0,
          filenameInput: 'clip_name',
          label: 'CLIP 模型'
        },
        vaeLoader: {
          nodeId: '15',
          outputIndex: 0,
          filenameInput: 'vae_name',
          label: 'VAE 模型'
        },
        modelConsumers: [
          { nodeId: '19', inputName: 'model' }
        ],
        clipConsumers: [
          { nodeId: '11', inputName: 'clip' },
          { nodeId: '12', inputName: 'clip' }
        ]
      },
      parameterBindings: [
        { id: 'prompt', nodeId: '11', inputName: 'text', label: '正向提示词', control: 'textarea', rows: 4 },
        { id: 'negative_prompt', nodeId: '12', inputName: 'text', label: '负面提示词', control: 'textarea', rows: 3 },
        { id: 'seed', nodeId: '19', inputName: 'seed', label: '种子', control: 'number' },
        { id: 'steps', nodeId: '19', inputName: 'steps', label: '采样步数', control: 'range', min: 1, max: 50, step: 1 },
        { id: 'cfg', nodeId: '19', inputName: 'cfg', label: 'CFG Scale', control: 'range', min: 1, max: 20, step: 0.1 },
        { id: 'sampler_name', nodeId: '19', inputName: 'sampler_name', label: '采样器', control: 'select' },
        { id: 'scheduler', nodeId: '19', inputName: 'scheduler', label: '调度器', control: 'select' },
        { id: 'denoise', nodeId: '19', inputName: 'denoise', label: '重绘幅度', control: 'range', min: 0, max: 1, step: 0.01 },
        { id: 'width', nodeId: '48', inputName: 'width', label: '宽度', control: 'number', min: 64, max: 2048, step: 64 },
        { id: 'height', nodeId: '48', inputName: 'height', label: '高度', control: 'number', min: 64, max: 2048, step: 64 },
        { id: 'batch_size', nodeId: '48', inputName: 'batch_size', label: '每批数量', control: 'number', min: 1, max: 8, step: 1 }
      ]
    },
    workflow: {
      "8": {
        "inputs": {
          "samples": [
            "19",
            0
          ],
          "vae": [
            "15",
            0
          ]
        },
        "class_type": "VAEDecode",
        "_meta": {
          "title": "VAE解码"
        }
      },
      "11": {
        "inputs": {
          "text": "{{prompt}}",
          "clip": [
            "45",
            0
          ]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器"
        }
      },
      "12": {
        "inputs": {
          "text": "{{negative_prompt}}",
          "clip": [
            "45",
            0
          ]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器"
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
          "seed": "{{seed}}",
          "steps": "{{steps}}",
          "cfg": "{{cfg}}",
          "sampler_name": "{{sampler_name}}",
          "scheduler": "{{scheduler}}",
          "denoise": "{{denoise}}",
          "model": [
            "44",
            0
          ],
          "positive": [
            "11",
            0
          ],
          "negative": [
            "12",
            0
          ],
          "latent_image": [
            "48",
            0
          ]
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
          "width": "{{width}}",
          "height": "{{height}}",
          "batch_size": "{{batch_size}}"
        },
        "class_type": "EmptyLatentImage",
        "_meta": {
          "title": "空Latent"
        }
      },
      "50": {
        "inputs": {
          "filename_prefix": "ComfyUI",
          "images": [
            "8",
            0
          ]
        },
        "class_type": "SaveImage",
        "_meta": {
          "title": "保存图像"
        }
      }
    }
  },
  {
    id: 'anima_preview2_lora_v1',
    schemaVersion: 2,
    name: 'anima_preview2_lora_v1',
    description: 'Anima Preview 2 文生图 workflow，内置蒸馏 LoRA、Qwen CLIP 与 VAE。',
    isBuiltin: true,
    defaults: {
      width: 896,
      height: 1152,
      batch_size: 1,
      seed: 1057109426240887,
      steps: 12,
      cfg: 1,
      prompt: 'masterpiece, best quality',
      negative_prompt: 'worst quality, low quality, bad anatomy'
    },
    editor: {
      profile: 'txt2img-lora-v1',
      roles: {
        modelLoader: {
          nodeId: '44',
          outputIndex: 0,
          filenameInput: 'unet_name',
          label: 'UNET 模型'
        },
        clipLoader: {
          nodeId: '45',
          outputIndex: 0,
          filenameInput: 'clip_name',
          label: 'CLIP 模型'
        },
        vaeLoader: {
          nodeId: '15',
          outputIndex: 0,
          filenameInput: 'vae_name',
          label: 'VAE 模型'
        },
        modelConsumers: [
          { nodeId: '19', inputName: 'model' }
        ],
        clipConsumers: [
          { nodeId: '11', inputName: 'clip' },
          { nodeId: '12', inputName: 'clip' }
        ]
      },
      parameterBindings: [
        { id: 'prompt', nodeId: '11', inputName: 'text', label: '正向提示词', control: 'textarea', rows: 4 },
        { id: 'negative_prompt', nodeId: '12', inputName: 'text', label: '负面提示词', control: 'textarea', rows: 3 },
        { id: 'seed', nodeId: '19', inputName: 'seed', label: '种子', control: 'number' },
        { id: 'steps', nodeId: '19', inputName: 'steps', label: '采样步数', control: 'range', min: 1, max: 50, step: 1 },
        { id: 'cfg', nodeId: '19', inputName: 'cfg', label: 'CFG Scale', control: 'range', min: 0, max: 20, step: 0.1 },
        { id: 'width', nodeId: '54', inputName: 'width', label: '宽度', control: 'number', min: 64, max: 2048, step: 64 },
        { id: 'height', nodeId: '54', inputName: 'height', label: '高度', control: 'number', min: 64, max: 2048, step: 64 },
        { id: 'batch_size', nodeId: '54', inputName: 'batch_size', label: '每批数量', control: 'number', min: 1, max: 8, step: 1 }
      ]
    },
    workflow: {
      "8": {
        "inputs": {
          "samples": [
            "19",
            0
          ],
          "vae": [
            "15",
            0
          ]
        },
        "class_type": "VAEDecode",
        "_meta": {
          "title": "VAE解码"
        }
      },
      "11": {
        "inputs": {
          "text": "{{prompt}}",
          "clip": [
            "49",
            1
          ]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器"
        }
      },
      "12": {
        "inputs": {
          "text": "{{negative_prompt}}",
          "clip": [
            "49",
            1
          ]
        },
        "class_type": "CLIPTextEncode",
        "_meta": {
          "title": "CLIP文本编码器"
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
          "seed": "{{seed}}",
          "steps": "{{steps}}",
          "cfg": "{{cfg}}",
          "sampler_name": "euler_ancestral",
          "scheduler": "normal",
          "denoise": 1,
          "model": [
            "49",
            0
          ],
          "positive": [
            "11",
            0
          ],
          "negative": [
            "12",
            0
          ],
          "latent_image": [
            "54",
            0
          ]
        },
        "class_type": "KSampler",
        "_meta": {
          "title": "K采样器"
        }
      },
      "44": {
        "inputs": {
          "unet_name": "anima-preview2.safetensors",
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
      "49": {
        "inputs": {
          "lora_name": "anima_preview_rdbt_finetuned_cfg_distilled_v0.12.safetensors",
          "strength_model": 1,
          "strength_clip": 1,
          "model": [
            "44",
            0
          ],
          "clip": [
            "45",
            0
          ]
        },
        "class_type": "LoraLoader",
        "_meta": {
          "title": "LoRA加载器",
          "runpodEditor": {
            "role": "lora",
            "order": 0
          }
        }
      },
      "54": {
        "inputs": {
          "width": "{{width}}",
          "height": "{{height}}",
          "batch_size": "{{batch_size}}"
        },
        "class_type": "EmptyLatentImage",
        "_meta": {
          "title": "空Latent"
        }
      },
      "55": {
        "inputs": {
          "filename_prefix": "ComfyUI",
          "images": [
            "8",
            0
          ]
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
