/**
 * ComfyUI API workflow graph and controlled editor helpers.
 */
(function initWorkflowEditor(global) {
  'use strict';

  if (global.cytoscape && global.cytoscapeDagre) {
    global.cytoscape.use(global.cytoscapeDagre);
  }

  const MANAGED_LORA_ROLE = 'lora';

  function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isPrimitive(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }

  function isLink(value, workflow) {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const sourceId = String(value[0]);
    return Object.prototype.hasOwnProperty.call(workflow || {}, sourceId)
      && Number.isInteger(Number(value[1]));
  }

  function getNodeTitle(node, nodeId) {
    const metaTitle = node && node._meta && node._meta.title;
    return String(metaTitle || node.class_type || `节点 ${nodeId}`);
  }

  function getNodeCategory(classType) {
    const type = String(classType || '').toLowerCase();
    if (type.includes('lora')) return 'lora';
    if (type.includes('loader')) return 'loader';
    if (type.includes('textencode') || type.includes('conditioning')) return 'conditioning';
    if (type.includes('sampler')) return 'sampler';
    if (type.includes('latent')) return 'latent';
    if (type.includes('decode') || type.includes('vae')) return 'decode';
    if (type.includes('save') || type.includes('preview')) return 'output';
    return 'other';
  }

  function parse(workflow) {
    if (!isObject(workflow)) {
      return { nodes: [], edges: [], warnings: ['Workflow 必须是对象'] };
    }

    const nodes = [];
    const edges = [];
    const warnings = [];

    Object.entries(workflow).forEach(([nodeId, node]) => {
      if (!isObject(node)) {
        warnings.push(`节点 ${nodeId} 不是有效对象`);
        return;
      }

      const inputs = isObject(node.inputs) ? node.inputs : {};
      const primitiveInputs = [];
      const linkedInputs = [];
      const complexInputs = [];

      Object.entries(inputs).forEach(([inputName, value]) => {
        if (isLink(value, workflow)) {
          const link = {
            sourceNodeId: String(value[0]),
            sourceOutputIndex: Number(value[1]),
            targetNodeId: String(nodeId),
            targetInputName: inputName
          };
          linkedInputs.push(link);
          edges.push({
            id: `${link.sourceNodeId}:${link.sourceOutputIndex}->${nodeId}:${inputName}`,
            ...link
          });
        } else if (isPrimitive(value)) {
          primitiveInputs.push({ name: inputName, value });
        } else {
          complexInputs.push({ name: inputName, value: deepClone(value) });
        }
      });

      nodes.push({
        id: String(nodeId),
        classType: String(node.class_type || 'Unknown'),
        title: getNodeTitle(node, nodeId),
        category: getNodeCategory(node.class_type),
        primitiveInputs,
        linkedInputs,
        complexInputs,
        isManagedLora: !!(node._meta
          && node._meta.runpodEditor
          && node._meta.runpodEditor.role === MANAGED_LORA_ROLE)
      });
    });

    edges.forEach(edge => {
      if (!Object.prototype.hasOwnProperty.call(workflow, edge.sourceNodeId)) {
        warnings.push(`连线来源节点不存在: ${edge.sourceNodeId}`);
      }
    });

    return { nodes, edges, warnings };
  }

  function findPurePlaceholder(value) {
    if (typeof value !== 'string') return '';
    const match = value.match(/^\{\{([^}]+)\}\}$/);
    return match ? match[1].trim() : '';
  }

  function inferParameterBindings(workflow) {
    if (!isObject(workflow)) return [];
    const bindings = [];

    Object.entries(workflow).forEach(([nodeId, node]) => {
      const inputs = isObject(node && node.inputs) ? node.inputs : {};
      Object.entries(inputs).forEach(([inputName, value]) => {
        const parameterId = findPurePlaceholder(value);
        if (!parameterId) return;
        bindings.push({
          id: parameterId,
          nodeId: String(nodeId),
          inputName,
          label: inputName,
          control: 'text'
        });
      });
    });

    return bindings;
  }

  function normalizeEditor(editor) {
    const next = isObject(editor) ? deepClone(editor) : {};
    return {
      profile: String(next.profile || ''),
      roles: isObject(next.roles) ? next.roles : {},
      parameterBindings: Array.isArray(next.parameterBindings) ? next.parameterBindings : []
    };
  }

  function mergeParameterBindings(workflow, editor) {
    const configured = normalizeEditor(editor).parameterBindings;
    const inferred = inferParameterBindings(workflow);
    const byId = new Map();
    inferred.forEach(binding => byId.set(binding.id, binding));
    configured.forEach(binding => {
      if (!binding || !binding.id) return;
      byId.set(String(binding.id), { ...byId.get(String(binding.id)), ...deepClone(binding) });
    });
    return Array.from(byId.values());
  }

  function getBindingForInput(workflow, editor, nodeId, inputName) {
    return mergeParameterBindings(workflow, editor).find(binding =>
      String(binding.nodeId) === String(nodeId) && binding.inputName === inputName
    ) || null;
  }

  function setInput(workflow, nodeId, inputName, value) {
    const next = deepClone(workflow);
    if (!next || !next[nodeId] || !isObject(next[nodeId].inputs)) {
      throw new Error(`节点 ${nodeId} 或输入 ${inputName} 不存在`);
    }
    next[nodeId].inputs[inputName] = value;
    return next;
  }

  function exposeInput(workflow, editor, options) {
    const nodeId = String(options && options.nodeId || '');
    const inputName = String(options && options.inputName || '');
    const parameterId = String(options && options.id || '').trim();
    const normalizedEditor = normalizeEditor(editor);

    if (!parameterId || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameterId)) {
      throw new Error('参数 ID 只能包含字母、数字和下划线，且不能以数字开头');
    }
    if (!workflow || !workflow[nodeId] || !isObject(workflow[nodeId].inputs)) {
      throw new Error(`节点 ${nodeId} 不存在`);
    }

    const currentValue = workflow[nodeId].inputs[inputName];
    if (!isPrimitive(currentValue)) {
      throw new Error('只能将普通字符串、数字或布尔输入加入参数');
    }

    const existing = mergeParameterBindings(workflow, normalizedEditor);
    if (existing.some(binding => binding.id === parameterId)) {
      throw new Error(`参数 ID 已存在: ${parameterId}`);
    }
    if (existing.some(binding => String(binding.nodeId) === nodeId && binding.inputName === inputName)) {
      throw new Error('该字段已经加入参数');
    }

    const binding = {
      id: parameterId,
      nodeId,
      inputName,
      label: String(options.label || inputName),
      control: String(options.control || inferControl(currentValue)),
      defaultValue: deepClone(currentValue)
    };

    ['min', 'max', 'step', 'rows'].forEach(key => {
      if (options[key] !== undefined && options[key] !== '') {
        binding[key] = Number(options[key]);
      }
    });

    normalizedEditor.parameterBindings.push(binding);
    return {
      workflow: setInput(workflow, nodeId, inputName, `{{${parameterId}}}`),
      editor: normalizedEditor,
      binding,
      initialValue: deepClone(currentValue)
    };
  }

  function removeBinding(workflow, editor, parameterId, replacementValue) {
    const normalizedEditor = normalizeEditor(editor);
    const binding = mergeParameterBindings(workflow, normalizedEditor)
      .find(item => item.id === parameterId);
    if (!binding) throw new Error(`参数不存在: ${parameterId}`);

    normalizedEditor.parameterBindings = normalizedEditor.parameterBindings
      .filter(item => item && item.id !== parameterId);

    return {
      workflow: setInput(
        workflow,
        String(binding.nodeId),
        binding.inputName,
        replacementValue !== undefined ? replacementValue : binding.defaultValue
      ),
      editor: normalizedEditor,
      binding
    };
  }

  function inferControl(value) {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'checkbox';
    if (typeof value === 'string' && value.length > 100) return 'textarea';
    return 'text';
  }

  function getNextNumericNodeId(workflow, reservedIds) {
    const reserved = new Set((reservedIds || []).map(String));
    let maxId = 0;
    Object.keys(workflow || {}).forEach(id => {
      if (/^\d+$/.test(id)) maxId = Math.max(maxId, Number(id));
    });
    let candidate = maxId + 1;
    while (Object.prototype.hasOwnProperty.call(workflow || {}, String(candidate))
      || reserved.has(String(candidate))) {
      candidate += 1;
    }
    return String(candidate);
  }

  function validateProfile(workflow, editor) {
    const normalized = normalizeEditor(editor);
    if (normalized.profile !== 'txt2img-lora-v1') {
      return { valid: false, errors: ['当前模板未启用文生图 LoRA 编辑 profile'] };
    }

    const errors = [];
    const roles = normalized.roles;
    ['modelLoader', 'clipLoader'].forEach(roleName => {
      const role = roles[roleName];
      if (!role || !workflow || !workflow[String(role.nodeId)]) {
        errors.push(`缺少 ${roleName} 节点配置`);
      }
    });

    ['modelConsumers', 'clipConsumers'].forEach(roleName => {
      const consumers = Array.isArray(roles[roleName]) ? roles[roleName] : [];
      if (consumers.length === 0) errors.push(`缺少 ${roleName} 配置`);
      consumers.forEach(consumer => {
        const node = workflow && workflow[String(consumer.nodeId)];
        if (!node || !isObject(node.inputs)
          || !Object.prototype.hasOwnProperty.call(node.inputs, consumer.inputName)) {
          errors.push(`消费节点字段不存在: ${consumer.nodeId}.${consumer.inputName}`);
        }
      });
    });

    return { valid: errors.length === 0, errors };
  }

  function readManagedLoras(workflow) {
    if (!isObject(workflow)) return [];
    return Object.entries(workflow)
      .filter(([, node]) => node
        && node._meta
        && node._meta.runpodEditor
        && node._meta.runpodEditor.role === MANAGED_LORA_ROLE)
      .map(([nodeId, node]) => ({
        nodeId,
        name: String(node.inputs && node.inputs.lora_name || ''),
        strengthModel: Number(node.inputs && node.inputs.strength_model !== undefined
          ? node.inputs.strength_model : 1),
        strengthClip: Number(node.inputs && node.inputs.strength_clip !== undefined
          ? node.inputs.strength_clip : 1),
        order: Number(node._meta.runpodEditor.order || 0)
      }))
      .sort((a, b) => a.order - b.order);
  }

  function syncLoraChain(workflow, editor, loras) {
    const validation = validateProfile(workflow, editor);
    if (!validation.valid) throw new Error(validation.errors.join('；'));

    const normalized = normalizeEditor(editor);
    const roles = normalized.roles;
    const next = deepClone(workflow);
    const oldManagedIds = Object.keys(next).filter(nodeId => {
      const node = next[nodeId];
      return node && node._meta && node._meta.runpodEditor
        && node._meta.runpodEditor.role === MANAGED_LORA_ROLE;
    });
    oldManagedIds.forEach(nodeId => delete next[nodeId]);

    let modelRef = [String(roles.modelLoader.nodeId), Number(roles.modelLoader.outputIndex || 0)];
    let clipRef = [String(roles.clipLoader.nodeId), Number(roles.clipLoader.outputIndex || 0)];
    const reservedIds = [];
    const normalizedLoras = (Array.isArray(loras) ? loras : []).map((lora, index) => {
      let nodeId = lora && lora.nodeId ? String(lora.nodeId) : '';
      if (!/^\d+$/.test(nodeId) || Object.prototype.hasOwnProperty.call(next, nodeId)
        || reservedIds.includes(nodeId)) {
        nodeId = getNextNumericNodeId(next, reservedIds);
      }
      reservedIds.push(nodeId);

      const name = String(lora && lora.name || '').trim();
      const strengthModel = Number(lora && lora.strengthModel);
      const strengthClip = Number(lora && lora.strengthClip);
      const safeModel = Number.isFinite(strengthModel) ? strengthModel : 1;
      const safeClip = Number.isFinite(strengthClip) ? strengthClip : 1;

      next[nodeId] = {
        inputs: {
          model: modelRef,
          clip: clipRef,
          lora_name: name,
          strength_model: safeModel,
          strength_clip: safeClip
        },
        class_type: 'LoraLoader',
        _meta: {
          title: name ? `LoRA ${index + 1}: ${name}` : `LoRA ${index + 1}`,
          runpodEditor: { role: MANAGED_LORA_ROLE, order: index }
        }
      };

      modelRef = [nodeId, 0];
      clipRef = [nodeId, 1];
      return { nodeId, name, strengthModel: safeModel, strengthClip: safeClip };
    });

    (roles.modelConsumers || []).forEach(consumer => {
      next[String(consumer.nodeId)].inputs[consumer.inputName] = modelRef;
    });
    (roles.clipConsumers || []).forEach(consumer => {
      next[String(consumer.nodeId)].inputs[consumer.inputName] = clipRef;
    });

    return { workflow: next, loras: normalizedLoras };
  }

  global.WorkflowEditor = {
    deepClone,
    exposeInput,
    findPurePlaceholder,
    getBindingForInput,
    inferControl,
    inferParameterBindings,
    isLink,
    mergeParameterBindings,
    normalizeEditor,
    parse,
    readManagedLoras,
    removeBinding,
    setInput,
    syncLoraChain,
    validateProfile
  };
})(window);
