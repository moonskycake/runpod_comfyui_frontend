/**
 * Placeholder Engine
 * 扫描、解析、替换 workflow 中的占位符 {{name}}
 */

const PlaceholderEngine = {
  // 占位符正则
  PLACEHOLDER_REGEX: /\{\{([^}]+)\}\}/g,

  // 已知的占位符配置（决定控件类型、默认值、范围）
  KNOWN_PLACEHOLDERS: {
    // 图片尺寸
    width: {
      type: 'number',
      label: '宽度',
      default: 512,
      min: 64,
      max: 2048,
      step: 64
    },
    height: {
      type: 'number',
      label: '高度',
      default: 512,
      min: 64,
      max: 2048,
      step: 64
    },

    // 提示词
    prompt: {
      type: 'textarea',
      label: '正向提示词',
      default: 'masterpiece, best quality',
      rows: 4
    },
    negative_prompt: {
      type: 'textarea',
      label: '负面提示词',
      default: 'worst quality, low quality, bad anatomy',
      rows: 3
    },

    // 采样参数
    seed: {
      type: 'number',
      label: '种子',
      default: -1,
      min: -1,
      max: 2147483647,
      step: 1
    },
    steps: {
      type: 'range',
      label: '采样步数',
      default: 20,
      min: 1,
      max: 150,
      step: 1
    },
    cfg: {
      type: 'range',
      label: 'CFG Scale',
      default: 7,
      min: 1,
      max: 30,
      step: 0.5
    },
    denoise: {
      type: 'range',
      label: '重绘幅度',
      default: 1.0,
      min: 0,
      max: 1,
      step: 0.01
    },
    batch_size: {
      type: 'number',
      label: '每批数量',
      default: 1,
      min: 1,
      max: 8,
      step: 1
    },

    // 采样器/调度器
    sampler_name: {
      type: 'select',
      label: '采样器',
      default: 'euler',
      options: [
        'euler', 'euler_ancestral', 'heun', 'heunpp2',
        'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast',
        'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_sde',
        'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde',
        'dpmpp_2m_sde_gpu', 'ddim', 'uni_pc', 'uni_pc_bh2'
      ]
    },
    scheduler: {
      type: 'select',
      label: '调度器',
      default: 'normal',
      options: [
        'normal', 'karras', 'exponential', 'sgm_uniform',
        'simple', 'ddim_uniform'
      ]
    },

    // 输入图片（特殊占位符）
    input_image: {
      type: 'image',
      label: '输入图片',
      default: 'input.png',
      description: '用于图生图或 ControlNet 的输入图片'
    }
  },

  /**
   * 扫描 workflow 中的所有占位符
   * @param {Object} workflow - workflow 对象
   * @returns {Array} 占位符列表 [{name, type, label, ...}]
   */
  scan(workflow) {
    const found = new Set();
    const result = [];

    // 递归遍历对象
    const traverse = (obj) => {
      if (typeof obj === 'string') {
        // 查找字符串中的所有占位符
        let match;
        while ((match = this.PLACEHOLDER_REGEX.exec(obj)) !== null) {
          found.add(match[1].trim());
        }
        // 重置正则
        this.PLACEHOLDER_REGEX.lastIndex = 0;
      } else if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else if (typeof obj === 'object' && obj !== null) {
        Object.values(obj).forEach(traverse);
      }
    };

    traverse(workflow);

    // 构建结果
    found.forEach(name => {
      const config = this.KNOWN_PLACEHOLDERS[name] || {
        type: 'text',
        label: name,
        default: ''
      };
      result.push({
        name,
        ...config
      });
    });

    return result;
  },

  /**
   * 替换 workflow 中的占位符
   * @param {Object} workflow - 原始 workflow 对象（会被修改）
   * @param {Object} values - 占位符值 {name: value}
   * @returns {Object} 替换后的 workflow（深拷贝）
   */
  replace(workflow, values) {
    // 深拷贝
    const result = JSON.parse(JSON.stringify(workflow));

    // 递归替换
    const traverse = (obj) => {
      if (typeof obj === 'string') {
        // 检查是否是纯占位符（如 "{{width}}"）
        const pureMatch = obj.match(/^\{\{([^}]+)\}\}$/);
        if (pureMatch) {
          const name = pureMatch[1].trim();
          const value = values[name];
          if (value !== undefined) {
            // 根据占位符类型决定返回类型
            const config = this.KNOWN_PLACEHOLDERS[name];
            if (config && config.type === 'number') {
              return Number(value);
            }
            return value;
          }
        }

        // 混合替换（如 "masterpiece, {{prompt}}")
        return obj.replace(this.PLACEHOLDER_REGEX, (match, name) => {
          const trimmedName = name.trim();
          const value = values[trimmedName];
          return value !== undefined ? value : match;
        });
      } else if (Array.isArray(obj)) {
        return obj.map(traverse);
      } else if (typeof obj === 'object' && obj !== null) {
        const newObj = {};
        for (const [key, value] of Object.entries(obj)) {
          newObj[key] = traverse(value);
        }
        return newObj;
      }
      return obj;
    };

    return traverse(result);
  },

  /**
   * 获取占位符的默认值
   * @param {Array} placeholders - 占位符列表
   * @returns {Object} 默认值对象 {name: defaultValue}
   */
  getDefaults(placeholders) {
    const defaults = {};
    placeholders.forEach(p => {
      defaults[p.name] = p.default;
    });
    return defaults;
  },

  /**
   * 验证占位符值
   * @param {Array} placeholders - 占位符列表
   * @param {Object} values - 用户输入的值
   * @returns {Object} {valid: boolean, errors: {name: message}}
   */
  validate(placeholders, values) {
    const errors = {};

    placeholders.forEach(p => {
      const value = values[p.name];

      if (value === undefined || value === null || value === '') {
        // 可选：检查必填
        return;
      }

      // 数字类型验证
      if (p.type === 'number' || p.type === 'range') {
        const num = Number(value);
        if (isNaN(num)) {
          errors[p.name] = `${p.label} 必须是数字`;
        } else if (p.min !== undefined && num < p.min) {
          errors[p.name] = `${p.label} 不能小于 ${p.min}`;
        } else if (p.max !== undefined && num > p.max) {
          errors[p.name] = `${p.label} 不能大于 ${p.max}`;
        }
      }
    });

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  },

  /**
   * 创建预设尺寸选项
   * @returns {Array} 预设选项 [{name, width, height}]
   */
  getSizePresets() {
    return [
      { name: 'Square (1:1)', width: 512, height: 512 },
      { name: 'Portrait (2:3)', width: 512, height: 768 },
      { name: 'Portrait (3:4)', width: 512, height: 682 },
      { name: 'Portrait (9:16)', width: 512, height: 910 },
      { name: 'Landscape (3:2)', width: 768, height: 512 },
      { name: 'Landscape (4:3)', width: 682, height: 512 },
      { name: 'Landscape (16:9)', width: 910, height: 512 },
      { name: 'SDXL (1:1)', width: 1024, height: 1024 },
      { name: 'SDXL Portrait', width: 832, height: 1216 },
      { name: 'SDXL Landscape', width: 1216, height: 832 }
    ];
  }
};

// 导出到全局
window.PlaceholderEngine = PlaceholderEngine;
