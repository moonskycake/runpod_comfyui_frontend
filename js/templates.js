/**
 * Template Manager
 * 管理 ComfyUI workflow 模板（内置 + 用户自定义）
 */

const TemplateManager = {
  // localStorage key
  STORAGE_KEY: 'comfyui_templates',

  // 内置模板
  builtinTemplates: [],

  // 运行时模板（统一库详情，不写入 localStorage）
  runtimeTemplates: [],

  /**
   * 本地模板只接受站内预览接口 URL（公开 revision 路径），其余按无图处理。
   * 与 CatalogClient.normalizePreview 保持同一契约，但本模块可独立加载。
   * @param {object|null|undefined} preview
   */
  sanitizePreview(preview) {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const url = typeof preview.url === 'string' ? preview.url.trim() : '';
    if (!url || url.charAt(0) !== '/' || url.startsWith('//') || url.length > 2048) return null;
    if (/[\\\u0000-\u001f\s]/.test(url) || url.indexOf('..') >= 0) return null;
    if (!/^\/api\/catalog\/[^/?#]+\/preview(?:\?[^#]*)?$/.test(url)) return null;
    if (!/(?:^|&)revision=\d+(?:&|$)/.test(url.split('?')[1] || '')) return null;
    if (String(preview.mime || '').toLowerCase() !== 'image/webp') return null;
    const width = Number(preview.width);
    const height = Number(preview.height);
    const bytes = Number(preview.bytes);
    if (!Number.isInteger(width) || width <= 0 || width > 480) return null;
    if (!Number.isInteger(height) || height <= 0 || height > 480) return null;
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 64 * 1024) return null;
    return { url, width, height, bytes, mime: 'image/webp' };
  },

  /**
   * 统一库/内置模板只读；只有本地模板可编辑删除。
   * @param {object} template
   * @returns {boolean}
   */
  isReadonly(template) {
    if (!template || typeof template !== 'object') return true;
    if (template.isBuiltin) return true;
    if (template.source === 'shared') return true;
    if (typeof template.id === 'string' && template.id.startsWith('shared:')) return true;
    return false;
  },

  /**
   * 加载所有模板（内置 + 统一库运行时 + 用户自定义）
   * @returns {Array} 模板列表
   */
  loadAll() {
    const userTemplates = this.loadUserTemplates();
    return [...this.builtinTemplates, ...this.runtimeTemplates, ...userTemplates];
  },

  /**
   * 注册统一库模板（仅当前会话，不持久化）。
   * @param {Array} templates
   */
  setRuntimeTemplates(templates) {
    this.runtimeTemplates = (Array.isArray(templates) ? templates : [])
      .filter(t => t && t.id)
      .map(t => ({ ...t, source: 'shared', isBuiltin: false }));
  },

  upsertRuntimeTemplate(template) {
    if (!template || !template.id) return;
    const list = this.runtimeTemplates.filter(t => t.id !== template.id);
    list.push({ ...template, source: 'shared', isBuiltin: false });
    this.runtimeTemplates = list;
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

    // 新本地模板使用 local: 命名空间；旧 user_* 历史 ID 保持不动
    const id = (template && typeof template.id === 'string' && template.id.startsWith('local:'))
      ? template.id
      : 'local:' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);

    const newTemplate = {
      id,
      schemaVersion: Number(template.schemaVersion || 2),
      name: template.name || '未命名模板',
      description: template.description || '',
      workflow: template.workflow,
      defaults: template.defaults || {},
      editor: template.editor || {},
      isBuiltin: false,
      source: 'local',
      sourceId: template.sourceId || '',
      sourceRevision: Number.isFinite(Number(template.sourceRevision))
        ? Number(template.sourceRevision)
        : null,
      preview: this.sanitizePreview(template.preview),
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
    if (this.isReadonly(userTemplates[index])) return false;

    const patch = updates && typeof updates === 'object' ? updates : {};
    const merged = {
      ...userTemplates[index],
      ...patch,
      updatedAt: Date.now()
    };
    if (Object.prototype.hasOwnProperty.call(patch, 'preview')) {
      merged.preview = this.sanitizePreview(patch.preview);
    }
    userTemplates[index] = merged;

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
    const target = userTemplates.find(t => t.id === id);
    if (!target) return false;
    if (this.isReadonly(target)) return false;
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
      schemaVersion: Number(template.schemaVersion || 2),
      name: template.name,
      description: template.description || '',
      workflow: template.workflow,
      defaults: template.defaults,
      editor: template.editor || {}
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

      // 1) 我们自己的模板格式: { name, description?, workflow, defaults? }
      if (data && typeof data === 'object' && !Array.isArray(data) && data.workflow !== undefined) {
        let workflowObj;
        if (typeof data.workflow === 'string') {
          workflowObj = JSON.parse(data.workflow);
        } else if (typeof data.workflow === 'object' && data.workflow !== null && !Array.isArray(data.workflow)) {
          workflowObj = data.workflow;
        } else {
          throw new Error('无效的 workflow 类型');
        }

        return {
          schemaVersion: Number(data.schemaVersion || 2),
          name: data.name || '导入的模板',
          description: data.description || '',
          workflow: workflowObj,
          defaults: data.defaults || {},
          editor: data.editor || {}
        };
      }

      // 2) RunPod 请求格式: { input: { workflow: ... } }
      if (data && typeof data === 'object' && !Array.isArray(data) && data.input && data.input.workflow) {
        return {
          schemaVersion: Number(data.schemaVersion || 2),
          name: data.name || '导入的工作流',
          description: data.description || '',
          workflow: data.input.workflow,
          defaults: data.defaults || {},
          editor: data.editor || {}
        };
      }

      // 3) 纯 ComfyUI workflow JSON（API Export）: 直接把整个对象当 workflow
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return {
          schemaVersion: 2,
          name: '导入的工作流',
          description: '',
          workflow: data,
          defaults: {},
          editor: {}
        };
      }

      throw new Error('无效的 JSON：必须是对象类型');
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
