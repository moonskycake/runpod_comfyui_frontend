/**
 * 设置管理
 * 处理 Endpoint ID 和 API Key 的存储与读取
 */

function createDefaultSettingsConfig() {
  return {
    endpointId: '',
    apiKey: '',
    rememberApiKey: false,
    runMode: 'run', // 'run' 或 'runsync'
    pollIntervalMs: 2000,

    // ========== 生成行为 ==========
    // 生成时是否锁定参数（注意：开启排队时会强制关闭锁定）
    lockParamsOnGenerate: true,
    // 是否允许并发生成
    allowConcurrent: false,
    // 是否允许排队生成（并发满时入队）
    allowQueue: false,
    // 并发生成上限（allowConcurrent=false 时等价为 1）
    maxConcurrent: 1,
    // 排队上限（allowQueue=false 时等价为 0）
    maxQueue: 5
  };
}

const Settings = {
  // 内存中的配置（apiKey 默认不持久化）
  config: createDefaultSettingsConfig(),

  // localStorage 键名
  KEYS: {
    ENDPOINT_ID: 'runpod_endpoint_id',
    API_KEY: 'runpod_api_key',
    REMEMBER_API_KEY: 'runpod_remember_api_key',
    RUN_MODE: 'runpod_run_mode',
    POLL_INTERVAL: 'runpod_poll_interval',

    LOCK_PARAMS_ON_GENERATE: 'runpod_lock_params_on_generate',
    ALLOW_CONCURRENT: 'runpod_allow_concurrent',
    ALLOW_QUEUE: 'runpod_allow_queue',
    MAX_CONCURRENT: 'runpod_max_concurrent',
    MAX_QUEUE: 'runpod_max_queue'
  },

  /**
   * 从 localStorage 加载配置
   */
  load() {
    const endpointId = localStorage.getItem(this.KEYS.ENDPOINT_ID) || '';
    const rememberApiKey = localStorage.getItem(this.KEYS.REMEMBER_API_KEY) === 'true';
    const runMode = localStorage.getItem(this.KEYS.RUN_MODE) || 'run';
    const pollIntervalMs = parseInt(localStorage.getItem(this.KEYS.POLL_INTERVAL)) || 2000;

    const lockParamsOnGenerateRaw = localStorage.getItem(this.KEYS.LOCK_PARAMS_ON_GENERATE);
    const lockParamsOnGenerate = lockParamsOnGenerateRaw === null
      ? this.config.lockParamsOnGenerate
      : lockParamsOnGenerateRaw === 'true';

    const allowConcurrentRaw = localStorage.getItem(this.KEYS.ALLOW_CONCURRENT);
    const allowConcurrent = allowConcurrentRaw === null
      ? this.config.allowConcurrent
      : allowConcurrentRaw === 'true';

    const allowQueueRaw = localStorage.getItem(this.KEYS.ALLOW_QUEUE);
    const allowQueue = allowQueueRaw === null
      ? this.config.allowQueue
      : allowQueueRaw === 'true';

    const maxConcurrentRaw = parseInt(localStorage.getItem(this.KEYS.MAX_CONCURRENT));
    const maxConcurrent = Number.isFinite(maxConcurrentRaw) ? maxConcurrentRaw : this.config.maxConcurrent;

    const maxQueueRaw = parseInt(localStorage.getItem(this.KEYS.MAX_QUEUE));
    const maxQueue = Number.isFinite(maxQueueRaw) ? maxQueueRaw : this.config.maxQueue;
    
    let apiKey = '';
    if (rememberApiKey) {
      apiKey = localStorage.getItem(this.KEYS.API_KEY) || '';
    }

    this.config = {
      endpointId,
      apiKey,
      rememberApiKey,
      runMode,
      pollIntervalMs,

      lockParamsOnGenerate,
      allowConcurrent,
      allowQueue,
      maxConcurrent,
      maxQueue
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

    localStorage.setItem(this.KEYS.LOCK_PARAMS_ON_GENERATE, String(!!this.config.lockParamsOnGenerate));
    localStorage.setItem(this.KEYS.ALLOW_CONCURRENT, String(!!this.config.allowConcurrent));
    localStorage.setItem(this.KEYS.ALLOW_QUEUE, String(!!this.config.allowQueue));
    localStorage.setItem(this.KEYS.MAX_CONCURRENT, String(Number(this.config.maxConcurrent || 1)));
    localStorage.setItem(this.KEYS.MAX_QUEUE, String(Number(this.config.maxQueue || 0)));

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
   * 获取默认配置（深拷贝）
   * @returns {Object} 默认配置
   */
  createDefaultConfig() {
    return createDefaultSettingsConfig();
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
    this.config = createDefaultSettingsConfig();
    
    Object.values(this.KEYS).forEach(key => {
      localStorage.removeItem(key);
    });
  }
};

// 页面加载时自动加载配置
Settings.load();

// 导出到全局
window.Settings = Settings;
