/**
 * RunPod 客户端
 * 封装 RunPod Serverless API 调用
 */

const RunpodClient = {
  // 配置
  config: {
    endpointId: '',
    apiKey: '',
    baseUrl: 'https://api.runpod.ai/v2'
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
   * 格式化错误
   * @param {Error} error - 错误对象
   * @returns {Object} 格式化后的错误信息
   */
  formatError(error) {
    if (error.response) {
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
        data
      };
    }
    
    return {
      success: false,
      message: error.message || '网络请求失败',
      status: null,
      data: null
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
        { headers: this.getHeaders(cfg) }
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
        { headers: this.getHeaders(cfg) }
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
    try {
      const response = await axios.post(
        `${this.buildUrl('/runsync', cfg)}?wait=${waitMs}`,
        payload,
        { headers: this.getHeaders(cfg) }
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
        { headers: this.getHeaders(cfg) }
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
        { headers: this.getHeaders(cfg) }
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
   * 轮询任务状态直到完成或失败
   * @param {string} jobId - 任务 ID
   * @param {Object} options - 选项
   * @param {number} options.intervalMs - 轮询间隔（默认 2000ms）
   * @param {Function} options.onStatus - 状态回调
   * @param {Function} options.shouldStop - 是否停止轮询的函数
   * @returns {Promise<Object>} 最终结果
   */
  async poll(jobId, options = {}, cfg) {
    const { 
      intervalMs = 2000, 
      onStatus = null,
      shouldStop = null 
    } = options;

    let lastStatus = null;

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
