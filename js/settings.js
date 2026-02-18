/**
 * 设置管理
 * 处理 Endpoint ID 和 API Key 的存储与读取
 */

const Settings = {
  // 内存中的配置（apiKey 默认不持久化）
  config: {
    endpointId: '',
    apiKey: '',
    rememberApiKey: false,
    runMode: 'run', // 'run' 或 'runsync'
    pollIntervalMs: 2000
  },

  // localStorage 键名
  KEYS: {
    ENDPOINT_ID: 'runpod_endpoint_id',
    API_KEY: 'runpod_api_key',
    REMEMBER_API_KEY: 'runpod_remember_api_key',
    RUN_MODE: 'runpod_run_mode',
    POLL_INTERVAL: 'runpod_poll_interval'
  },

  /**
   * 从 localStorage 加载配置
   */
  load() {
    const endpointId = localStorage.getItem(this.KEYS.ENDPOINT_ID) || '';
    const rememberApiKey = localStorage.getItem(this.KEYS.REMEMBER_API_KEY) === 'true';
    const runMode = localStorage.getItem(this.KEYS.RUN_MODE) || 'run';
    const pollIntervalMs = parseInt(localStorage.getItem(this.KEYS.POLL_INTERVAL)) || 2000;
    
    let apiKey = '';
    if (rememberApiKey) {
      apiKey = localStorage.getItem(this.KEYS.API_KEY) || '';
    }

    this.config = {
      endpointId,
      apiKey,
      rememberApiKey,
      runMode,
      pollIntervalMs
    };

    return this.config;
  },

  /**
   * 保存配置
   * @param {Object} cfg - 配置对象
   */
  save(cfg) {
    this.config = { ...this.config, ...cfg };

    // 始终保存 endpointId
    localStorage.setItem(this.KEYS.ENDPOINT_ID, this.config.endpointId);
    localStorage.setItem(this.KEYS.REMEMBER_API_KEY, this.config.rememberApiKey);
    localStorage.setItem(this.KEYS.RUN_MODE, this.config.runMode);
    localStorage.setItem(this.KEYS.POLL_INTERVAL, this.config.pollIntervalMs.toString());

    // apiKey 仅在用户勾选"记住"时保存
    if (this.config.rememberApiKey) {
      localStorage.setItem(this.KEYS.API_KEY, this.config.apiKey);
    } else {
      localStorage.removeItem(this.KEYS.API_KEY);
    }
  },

  /**
   * 获取当前配置
   * @returns {Object} 配置对象
   */
  get() {
    return { ...this.config };
  },

  /**
   * 从 URL 提取 Endpoint ID
   * @param {string} url - 完整 URL 或端点 ID
   * @returns {string} Endpoint ID
   */
  extractEndpointId(url) {
    if (!url) return '';
    
    // 如果已经是纯 ID（不含斜杠和协议），直接返回
    if (!url.includes('/') && !url.includes(':')) {
      return url.trim();
    }

    // 尝试从 URL 提取
    try {
      // 处理可能的 URL 格式：
      // https://api.runpod.ai/v2/ENDPOINT_ID/run
      // https://api.runpod.ai/v2/ENDPOINT_ID
      const match = url.match(/\/v2\/([^\/]+)/);
      if (match) {
        return match[1];
      }
    } catch (e) {
      // 解析失败，返回原值
    }

    return url.trim();
  },

  /**
   * 检查配置是否完整
   * @returns {boolean} 是否已配置
   */
  isConfigured() {
    return this.config.endpointId && this.config.apiKey;
  },

  /**
   * 清除所有配置
   */
  clear() {
    this.config = {
      endpointId: '',
      apiKey: '',
      rememberApiKey: false,
      runMode: 'run',
      pollIntervalMs: 2000
    };
    
    Object.values(this.KEYS).forEach(key => {
      localStorage.removeItem(key);
    });
  }
};

// 页面加载时自动加载配置
Settings.load();

// 导出到全局
window.Settings = Settings;
