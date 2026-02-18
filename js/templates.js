/**
 * Template Manager
 * 管理 ComfyUI workflow 模板（内置 + 用户自定义）
 */

const TemplateManager = {
  // localStorage key
  STORAGE_KEY: 'comfyui_templates',

  // 内置模板
  builtinTemplates: [],

  /**
   * 加载所有模板（内置 + 用户自定义）
   * @returns {Array} 模板列表
   */
  loadAll() {
    const userTemplates = this.loadUserTemplates();
    return [...this.builtinTemplates, ...userTemplates];
  },

  /**
   * 加载用户自定义模板
   * @returns {Array} 用户模板列表
   */
  loadUserTemplates() {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.error('加载模板失败:', e);
    }
    return [];
  },

  /**
   * 保存用户模板列表
   * @param {Array} templates - 模板列表
   */
  saveUserTemplates(templates) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(templates));
    } catch (e) {
      console.error('保存模板失败:', e);
      throw new Error('保存失败，可能是存储空间不足');
    }
  },

  /**
   * 获取单个模板
   * @param {string} id - 模板 ID
   * @returns {Object|null} 模板对象
   */
  get(id) {
    const all = this.loadAll();
    return all.find(t => t.id === id) || null;
  },

  /**
   * 添加用户模板
   * @param {Object} template - 模板对象 {id, name, workflow, defaults}
   * @returns {string} 新模板 ID
   */
  add(template) {
    const userTemplates = this.loadUserTemplates();

    // 生成唯一 ID
    const id = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    const newTemplate = {
      id,
      name: template.name || '未命名模板',
      workflow: template.workflow,
      defaults: template.defaults || {},
      isBuiltin: false,
      createdAt: Date.now()
    };

    userTemplates.push(newTemplate);
    this.saveUserTemplates(userTemplates);

    return id;
  },

  /**
   * 更新用户模板
   * @param {string} id - 模板 ID
   * @param {Object} updates - 更新的字段
   * @returns {boolean} 是否成功
   */
  update(id, updates) {
    const userTemplates = this.loadUserTemplates();
    const index = userTemplates.findIndex(t => t.id === id);

    if (index === -1) return false;

    userTemplates[index] = {
      ...userTemplates[index],
      ...updates,
      updatedAt: Date.now()
    };

    this.saveUserTemplates(userTemplates);
    return true;
  },

  /**
   * 删除用户模板
   * @param {string} id - 模板 ID
   * @returns {boolean} 是否成功
   */
  delete(id) {
    const userTemplates = this.loadUserTemplates();
    const filtered = userTemplates.filter(t => t.id !== id);

    if (filtered.length === userTemplates.length) return false;

    this.saveUserTemplates(filtered);
    return true;
  },

  /**
   * 导出模板为 JSON 文件
   * @param {string} id - 模板 ID
   * @returns {string} JSON 字符串
   */
  exportTemplate(id) {
    const template = this.get(id);
    if (!template) throw new Error('模板不存在');

    return JSON.stringify({
      name: template.name,
      workflow: template.workflow,
      defaults: template.defaults
    }, null, 2);
  },

  /**
   * 从 JSON 导入模板
   * @param {string} jsonString - JSON 字符串
   * @returns {Object} 导入的模板
   */
  importTemplate(jsonString) {
    try {
      const data = JSON.parse(jsonString);

      if (!data.workflow) {
        throw new Error('无效的模板格式：缺少 workflow');
      }

      // 验证 workflow 是否为有效 JSON
      if (typeof data.workflow === 'string') {
        JSON.parse(data.workflow);
      }

      return {
        name: data.name || '导入的模板',
        workflow: typeof data.workflow === 'string' ? data.workflow : JSON.stringify(data.workflow),
        defaults: data.defaults || {}
      };
    } catch (e) {
      throw new Error('导入失败: ' + e.message);
    }
  },

  /**
   * 设置内置模板
   * @param {Array} templates - 内置模板数组
   */
  setBuiltinTemplates(templates) {
    this.builtinTemplates = templates.map((t, index) => ({
      ...t,
      id: t.id || `builtin_${index}`,
      isBuiltin: true
    }));
  }
};

// 导出到全局
window.TemplateManager = TemplateManager;
