/**
 * RunPod 客户端
 * 封装 RunPod Serverless API 调用
 */

const RunpodClient = {
  // 配置
  config: {
    endpointId: '',
    apiKey: '',
    baseUrl: 'https://api.runpod.ai/v2',
    // 短请求（提交/状态/取消/健康检查）使用较短超时，避免界面无限等待。
    // runSync 属于长任务语义，超时按 wait + runSyncTimeoutExtraMs 计算。
    healthTimeoutMs: 15000,
    runTimeoutMs: 60000,
    statusTimeoutMs: 20000,
    cancelTimeoutMs: 15000,
    runSyncTimeoutExtraMs: 30000
  },

  /**
   * 设置配置
   * @param {Object} cfg - 配置对象
   * @param {string} cfg.endpointId - 端点 ID
   * @param {string} cfg.apiKey - API Key
   */
  setConfig(cfg) {
    this.config = { ...this.config, ...cfg };
  },

  /**
   * 获取请求头
   * @returns {Object} headers
   */
  getHeaders(cfg) {
    const c = cfg || this.config;
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${c.apiKey}`
    };
  },

  /**
   * 构建完整 URL
   * @param {string} path - 路径
   * @returns {string} 完整 URL
   */
  buildUrl(path, cfg) {
    const c = cfg || this.config;
    return `${c.baseUrl}/${c.endpointId}${path}`;
  },

  /**
   * 读取超时配置（可按实例覆盖）
   * @param {string} key - 配置键
   * @param {number} fallback - 兜底毫秒数
   * @param {Object} cfg - 可选的单请求配置
   * @returns {number} 生效超时
   */
  getTimeoutMs(key, fallback, cfg) {
    const source = cfg || this.config;
    const raw = source ? source[key] : undefined;
    const n = Math.trunc(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  },

  /**
   * 是否为网络超时（非 HTTP 响应错误）
   * @param {Error} error - 错误对象
   * @returns {boolean}
   */
  isTimeoutError(error) {
    if (!error || error.response) return false;
    const code = String(error.code || '');
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
    return /timeout/i.test(String(error.message || ''));
  },

  /**
   * 格式化错误
   * @param {Error} error - 错误对象
   * @returns {Object} 格式化后的错误信息
   */
  formatError(error) {
    if (error && error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      let message;
      switch (status) {
        case 401:
          message = 'API Key 无效或已过期';
          break;
        case 404:
          message = '端点不存在';
          break;
        case 429:
          message = '请求过于频繁，请稍后重试';
          break;
        case 500:
          message = '服务器内部错误';
          break;
        default:
          message = `请求失败 (${status})`;
      }
      
      return {
        success: false,
        message,
        status,
        data,
        timeout: false
      };
    }

    if (this.isTimeoutError(error)) {
      const rawTimeout = error && error.config ? Number(error.config.timeout) : 0;
      const seconds = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.round(rawTimeout / 1000)
        : 0;
      return {
        success: false,
        message: seconds
          ? `请求超时（${seconds} 秒内未响应）：请检查网络后重试；长任务可在历史记录中点击状态恢复查询`
          : '请求超时：请检查网络后重试；长任务可在历史记录中点击状态恢复查询',
        status: null,
        data: null,
        timeout: true
      };
    }

    return {
      success: false,
      message: (error && error.message) || '网络请求失败',
      status: null,
      data: null,
      timeout: false
    };
  },

  /**
   * 健康检查
   * @returns {Promise<Object>} health 结果
   */
  async health(cfg) {
    try {
      const response = await axios.get(
        this.buildUrl('/health', cfg),
        {
          headers: this.getHeaders(cfg),
          timeout: this.getTimeoutMs('healthTimeoutMs', 15000, cfg)
        }
      );
      
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return this.formatError(error);
    }
  },

  /**
   * 提交异步任务
   * @param {Object} payload - 请求体
   * @returns {Promise<Object>} { id, status }
   */
  async run(payload, cfg) {
    try {
      const response = await axios.post(
        this.buildUrl('/run', cfg),
        payload,
        {
          headers: this.getHeaders(cfg),
          timeout: this.getTimeoutMs('runTimeoutMs', 60000, cfg)
        }
      );
      
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return this.formatError(error);
    }
  },

  /**
   * 提交同步任务
   * @param {Object} payload - 请求体
   * @param {number} waitMs - 等待毫秒数（默认90000）
   * @returns {Promise<Object>} 完整结果
   */
  async runSync(payload, waitMs = 90000, cfg) {
    const wait = Math.trunc(Number(waitMs));
    const effectiveWaitMs = Number.isFinite(wait) && wait >= 0 ? wait : 90000;
    // 长任务：等待时间 + 缓冲，不因短超时误杀仍在执行的同步请求
    const timeoutMs = effectiveWaitMs + this.getTimeoutMs('runSyncTimeoutExtraMs', 30000, cfg);
    try {
      const response = await axios.post(
        `${this.buildUrl('/runsync', cfg)}?wait=${waitMs}`,
        payload,
        {
          headers: this.getHeaders(cfg),
          timeout: timeoutMs
        }
      );
      
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return this.formatError(error);
    }
  },

  /**
   * 查询任务状态
   * @param {string} jobId - 任务 ID
   * @returns {Promise<Object>} 状态信息
   */
  async status(jobId, cfg) {
    try {
      const response = await axios.get(
        this.buildUrl(`/status/${jobId}`, cfg),
        {
          headers: this.getHeaders(cfg),
          timeout: this.getTimeoutMs('statusTimeoutMs', 20000, cfg)
        }
      );
      
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return this.formatError(error);
    }
  },

  /**
   * 取消任务
   * @param {string} jobId - 任务 ID
   * @returns {Promise<Object>} 取消结果
   */
  async cancel(jobId, cfg) {
    try {
      const response = await axios.post(
        this.buildUrl(`/cancel/${jobId}`, cfg),
        {},
        {
          headers: this.getHeaders(cfg),
          timeout: this.getTimeoutMs('cancelTimeoutMs', 15000, cfg)
        }
      );
      
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return this.formatError(error);
    }
  },

  async waitForPollDelay(delayMs, shouldStop) {
    const totalMs = Math.max(0, Math.trunc(Number(delayMs) || 0));
    const deadline = Date.now() + totalMs;

    while (Date.now() < deadline) {
      if (shouldStop && shouldStop()) return false;
      const remainingMs = deadline - Date.now();
      await new Promise(resolve => setTimeout(resolve, Math.min(250, remainingMs)));
    }

    return !(shouldStop && shouldStop());
  },

  /**
   * 轮询任务状态直到完成或失败
   * @param {string} jobId - 任务 ID
   * @param {Object} options - 选项
   * @param {number} options.initialDelayMs - 第一次状态查询前的等待时间（默认 0ms）
   * @param {number} options.intervalMs - 轮询间隔（默认 2000ms）
   * @param {Function} options.onStatus - 状态回调
   * @param {Function} options.shouldStop - 是否停止轮询的函数
   * @returns {Promise<Object>} 最终结果
   */
  async poll(jobId, options = {}, cfg) {
    const {
      initialDelayMs = 0,
      intervalMs = 2000,
      onStatus = null,
      shouldStop = null
    } = options;

    let lastStatus = null;

    if (initialDelayMs > 0) {
      const shouldContinue = await this.waitForPollDelay(initialDelayMs, shouldStop);
      if (!shouldContinue) {
        return {
          success: false,
          cancelled: true,
          message: '用户取消',
          data: lastStatus
        };
      }
    }

    while (true) {
      // 检查是否需要停止
      if (shouldStop && shouldStop()) {
        return {
          success: false,
          cancelled: true,
          message: '用户取消',
          data: lastStatus
        };
      }

      const result = await this.status(jobId, cfg);

      // 取消可能发生在 status 请求飞行期间：迟到回包一律按取消处理，
      // 不把任务恢复为 IN_QUEUE/IN_PROGRESS，也不把请求失败误记为任务失败。
      if (shouldStop && shouldStop()) {
        return {
          success: false,
          cancelled: true,
          message: '用户取消',
          data: lastStatus
        };
      }

      if (!result.success) {
        return result;
      }

      const status = result.data.status;
      lastStatus = result.data;

      // 通知状态更新
      if (onStatus) {
        onStatus(result.data);
      }

      // 检查终止状态
      if (['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status)) {
        if (status === 'COMPLETED') {
          return {
            success: true,
            data: result.data
          };
        } else {
          return {
            success: false,
            message: `任务${status === 'FAILED' ? '失败' : status === 'TIMED_OUT' ? '超时' : '已取消'}`,
            status,
            data: result.data
          };
        }
      }

      // 等待下一次轮询
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
};

// 导出到全局
window.RunpodClient = RunpodClient;
