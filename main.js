const {
    Plugin,
    ItemView,
    Notice,
    TFile,
    Menu,
    Modal,
    FuzzySuggestModal,
    PluginSettingTab,
    Setting,
    setIcon,
    parseYaml
} = require('obsidian');

const VIEW_TYPE = 'hearth-gantt-view';
const DAY_MS = 24 * 60 * 60 * 1000;
const UNASSIGNED_PROJECT = '未归属项目';
const DEFAULT_COLORS = ['#8ec723', '#24b8db', '#9b87f5', '#f2a94f', '#ff6b8a', '#38bdf8', '#f97316', '#14b8a6'];
const TASK_MARKS = '📅⏳🛫🔁✅❌➕⏫🔼🔽🔺⏬';
const TASK_RE = /^\s*[-*+]\s\[(.)\]\s*(.*)$/;
const META_RE = new RegExp(`[${TASK_MARKS}][^\\n\\r${TASK_MARKS}]*`, 'gu');
const FOOTER_RE = /^\s*%%\s*kanban:settings/i;
const TASKNOTES_PLUGIN_ID = 'tasknotes';
const PROJECT_MARKER_FIELD = 'carrotProject';
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const COMPACT_DASHBOARD_BREAKPOINT = 720;
const MIN_CELL_WIDTH = 18;
const MAX_CELL_WIDTH = 144;
const ZOOM_FACTOR = 1.25;
const COMPACT_CELL_SCALE = 0.58;
const COMPACT_MIN_CELL_WIDTH = 32;
const COMPACT_MAX_CELL_WIDTH = 56;
const RANGE_PAST_DAYS = 14;
const RANGE_FUTURE_DAYS = 60;
const MIN_RANGE_DAYS = 60;
const TIMELINE_EXTEND_DAYS = 45;
const TIMELINE_EDGE_THRESHOLD = 120;
const PROJECT_WORKFLOWS = {
    general: { label: '普通项目', stages: [] },
    video: { label: '非合作视频', stages: ['planning', 'script', 'shooting', 'editing', 'publish'] },
    'sponsored-video': { label: '合作视频', stages: ['outline', 'script', 'shooting', 'editing', 'review', 'publish'] }
};
const WORKFLOW_STAGES = {
    outline: { title: '大纲', body: '- [ ] 人群、品牌对接方向与结构\n- [ ] 客户要求' },
    review: { title: '初稿送审与修改', body: '- [ ] 提交版本链接与提交时间\n- [ ] 客户反馈\n- [ ] 修改与重交\n- [ ] 最终通过证据（完成任务不等于客户批准）' },
    planning: { title: '策划', body: '- [ ] 明确人群与方向\n- [ ] 梳理内容结构' },
    script: { title: '脚本', body: '- [ ] 先验证关键功能可实现\n- [ ] 当前口播\n- [ ] 必要画面说明' },
    shooting: { title: '拍摄', body: '- [ ] 拍前准备：素材、演示内容与镜头清单\n- [ ] 拍摄与录屏：口播、生活工作画面\n- [ ] 素材核对与补拍检查' },
    editing: { title: '剪辑', body: '- [ ] 粗剪\n- [ ] 精剪与提示词字卡、字幕、音乐、封面\n- [ ] 成片检查与导出' },
    publish: { title: '发布', body: '- [ ] 标题／文案／话题\n- [ ] 平台检查\n- [ ] 记录实际发布链接' }
};
const WORKFLOW_STATES = new WeakMap();
const WORKFLOW_START = '<!-- carrot-gantt:workflow:start -->';
const WORKFLOW_END = '<!-- carrot-gantt:workflow:end -->';

// One service for standalone and embedded Gantt. All runtime code ships in main.js.
class ProjectWorkflowService {
    constructor(view) {
        this.view = view; this.app = view.app;
        if (!WORKFLOW_STATES.has(this.app.vault)) WORKFLOW_STATES.set(this.app.vault, { previews: new WeakMap(), locks: new Map(), attempts: new Map() });
        this.state = WORKFLOW_STATES.get(this.app.vault);
    }
    get tn() {
        const tn = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        if (typeof tn?.taskService?.createTask !== 'function') throw new Error('TaskNotes 任务服务不可用');
        return tn;
    }
    workflow(options) {
        const type = options.workflow || (options.isVideo ? 'video' : 'general');
        if (!PROJECT_WORKFLOWS[type]) throw new Error('未知项目类型');
        return type;
    }
    fields() {
        const fields = this.view.taskNotesFields(this.tn.settings);
        for (const key of Object.keys(fields)) fields[key] = this.tn.fieldMapper?.toUserField?.(key) || fields[key];
        const reserved = new Set(['carrotProject', 'project_workflow', 'workflow_version', 'type', 'project_status', 'video_stage', 'workflow_stage', 'workflow_order', 'workflow_request_id', 'workflow_request_signature', 'workflow_operation_id']);
        const values = Object.values(fields);
        if (values.some(value => reserved.has(value)) || new Set(values).size !== values.length) throw new Error('TaskNotes 字段映射与流程字段冲突，请先修正配置');
        if (reserved.has(this.tn.settings.taskPropertyName)) throw new Error('TaskNotes 识别字段与流程字段冲突');
        return fields;
    }
    // Property keys this transaction asked for (plus TaskNotes' own bookkeeping fields).
    // Anything outside this set inside a freshly created file means an outside writer.
    allowedPropertyKeys(payload = {}) {
        const fields = this.fields();
        const keys = new Set(['title']);
        for (const semantic of ['scheduled', 'due', 'timeEstimate', 'status', 'priority', 'projects']) if (payload[semantic] !== undefined) keys.add(fields[semantic]);
        for (const key of Object.keys(payload.customFrontmatter || {})) keys.add(key);
        for (const name of ['dateCreated', 'dateModified', 'completedDate', 'archiveTag', 'timeEntries', 'recurrence', 'recurrenceAnchor', 'completeInstances', 'skippedInstances', 'blockedBy', 'pomodoros', 'sortOrder']) {
            keys.add(this.tn.fieldMapper?.toUserField?.(name) || name);
        }
        return keys;
    }
    initialStatus() {
        const statuses = this.tn.settings?.customStatuses || [];
        const valid = statuses.filter(s => s.value && !s.isCompleted && !this.tn.statusManager?.isCompletedStatus?.(s.value));
        const preferred = valid.find(s => s.value === this.tn.settings.defaultTaskStatus);
        if (!valid.length) throw new Error('TaskNotes 未配置有效的未完成状态');
        return (preferred || valid.find(s => s.value === 'open') || valid[0]).value;
    }
    async read(file) {
        const text = await this.app.vault.read(file);
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        return { text, fm: match ? (parseYaml(match[1]) || {}) : {}, body: match ? text.slice(match[0].length) : text };
    }
    async createTask(payload, tx) {
        if (tx) payload = { ...payload, customFrontmatter: { ...payload.customFrontmatter, workflow_operation_id: tx.id } };
        const result = await this.tn.taskService.createTask(payload, { applyDefaults: false, applyTemplate: false });
        const info = result?.taskInfo || result;
        const file = this.app.vault.getAbstractFileByPath(info?.path || result?.file?.path || '');
        if (!(file instanceof TFile)) throw new Error('TaskNotes 已创建任务，但无法定位任务文件');
        if (tx) {
            if (tx.before.has(file.path)) throw new Error('TaskNotes 返回已存在文件，拒绝修改');
            const snapshot = await this.read(file);
            // A snapshot is only recyclable while the file still holds exactly what this
            // transaction asked for. TaskNotes keeps working after its own write (cache
            // refresh, webhooks), so a property we never requested means somebody else
            // wrote to this file in that window; a file we cannot prove is ours is kept.
            const foreign = Object.keys(snapshot.fm).filter(key => !this.allowedPropertyKeys(payload).has(key));
            tx.created.push({ file, originalPath: file.path, text: snapshot.text, fm: snapshot.fm, body: snapshot.body, mtime: file.stat?.mtime, foreignKeys: foreign,
                unsafe: snapshot.body.trim() !== String(payload.details || '').trim() || !!snapshot.fm.timeEntries?.length || foreign.length > 0 });
        }
        await this.view.ensureTaskNotesCollisionTitle(this.tn, file, payload.title, info);
        const actual = await this.read(file);
        const fields = this.fields();
        for (const semantic of ['scheduled', 'due', 'timeEstimate', 'status', 'priority', 'projects']) {
            const key = fields[semantic];
            const expected = payload[semantic];
            const matches = expected === undefined ? !Object.prototype.hasOwnProperty.call(actual.fm, key) : JSON.stringify(actual.fm[key]) === JSON.stringify(expected);
            if (!matches) {
                const record = tx?.created.find(item => item.file === file);
                if (record) record.unsafe = true;
                throw new Error(`TaskNotes 落盘字段不符合请求：${key}；保留文件供用户核对`);
            }
        }
        const record = tx?.created.find(item => item.file === file);
        if (record) {
            const withoutTitleUpdate = fm => Object.fromEntries(Object.entries(fm).filter(([key]) => key !== fields.title && key !== fields.dateModified));
            if (actual.body !== record.body || JSON.stringify(withoutTitleUpdate(actual.fm)) !== JSON.stringify(withoutTitleUpdate(record.fm))) record.unsafe = true;
            record.text = actual.text; record.mtime = file.stat?.mtime;
        }
        return file;
    }
    parentFields(type) {
        return { carrotProject: true, project_workflow: type, workflow_version: 1,
            ...(type !== 'general' ? { type: 'video', project_status: 'active', video_stage: 'idea' } : {}) };
    }
    async transaction(action, requestId) {
        const tx = { id: uid('workflow-operation'), created: [], registrations: [], touched: [], releaseParentLock: null, before: new Set(this.app.vault.getMarkdownFiles().map(f => f.path)) };
        try { return await action(tx); }
        catch (cause) {
            const residual = [];
            let settingsRecoveryError = '';
            if (tx.registrations.length) {
                const stored = this.view.plugin.settings.projects || [];
                for (const record of tx.registrations) {
                    const index = stored.indexOf(record.ref);
                    if (index >= 0 && JSON.stringify(record.ref) === record.snapshot) stored.splice(index, 1);
                    else if (index >= 0) residual.push(record.ref.notePath);
                }
                try { await this.view.plugin.saveSettings(); }
                catch { settingsRecoveryError = '；项目注册记录保存失败，请重试保存设置并核对项目列表'; }
            }
            // A provider may throw after creating a file. Its ownership tag lets us
            // report it, but without an acknowledged snapshot we never delete it.
            for (const file of this.app.vault.getMarkdownFiles()) {
                if (tx.before.has(file.path) || tx.created.some(r => r.file === file)) continue;
                try { if ((await this.read(file)).fm.workflow_operation_id === tx.id) residual.push(file.path); }
                catch { /* Unknown files are never adopted or deleted. */ }
            }
            for (const record of [...tx.created].reverse()) {
                const file = this.app.vault.getAbstractFileByPath(record.file.path);
                if (!file) continue;
                try {
                    const live = await this.read(file);
                    if (file !== record.file || file.path !== record.originalPath || record.unsafe || live.text !== record.text || file.stat?.mtime !== record.mtime || (file === tx.parent && residual.length)) {
                        residual.push(file.path); continue;
                    }
                    await this.app.vault.trash(file, true);
                } catch { residual.push(file.path); }
            }
            for (const record of tx.touched) {
                try { if ((await this.read(record.file)).text !== record.text) residual.push(record.file.path); }
                catch { residual.push(record.file.path); }
            }
            const error = new Error(`${cause?.message || cause}${settingsRecoveryError}${residual.length ? `；保留文件：${residual.join('、')}。请保留原参数重试，或从已有项目重新预览补齐。` : '；本轮未编辑的新文件已回收，可重试。'}`);
            error.residualPaths = residual;
            error.retryRequestId = requestId;
            throw error;
        } finally {
            // Creation holds the parent lock from the moment the parent file exists until
            // this cleanup has finished, so a repair entry point can never adopt a stage
            // file that is about to be recycled.
            tx.releaseParentLock?.();
        }
    }
    locked(key, signature, action) {
        const running = this.state.locks.get(key);
        if (running) {
            if (running.signature !== signature) return Promise.reject(new Error('该项目正在处理另一项流程操作，请完成后重新预览'));
            return running.promise;
        }
        const promise = Promise.resolve().then(action).finally(() => this.state.locks.delete(key));
        this.state.locks.set(key, { signature, promise });
        return promise;
    }
    // Same registry as locked(), but the caller releases it explicitly so one lock can span
    // creation, registration and the whole failure cleanup of a transaction.
    holdParentLock(path, signature) {
        const key = `parent:${path}`;
        const running = this.state.locks.get(key);
        if (running) {
            if (running.signature !== signature) throw new Error('该项目正在处理另一项流程操作，请完成后重新预览');
            return () => {};
        }
        let release;
        const promise = new Promise(resolve => { release = () => { if (this.state.locks.get(key)?.promise === promise) this.state.locks.delete(key); resolve(); }; });
        promise.catch(() => {});
        this.state.locks.set(key, { signature, promise });
        return release;
    }
    async create(title, options = {}) {
        title = String(title || '').trim();
        if (!title) throw new Error('请输入项目名称');
        this.fields();
        if (options.autoCreate !== false && PROJECT_WORKFLOWS[this.workflow(options)].stages.length) this.initialStatus();
        const signature = JSON.stringify([title, this.workflow(options), options.autoCreate !== false, options.status || '', options.priority || '', options.scheduled || '', options.due || '', options.notes || '', options.color || '']);
        const key = `new:${options.requestId || signature}`;
        const requestId = options.requestId || this.state.attempts.get(key) || uid('workflow');
        this.state.attempts.set(key, requestId);
        return this.locked(key, signature, async () => {
            const matches = [];
            for (const file of this.app.vault.getMarkdownFiles()) if ((await this.read(file)).fm.workflow_request_id === requestId) matches.push(file);
            if (matches.length > 1) throw new Error('项目请求存在多个候选，请用户解决歧义');
            let parent = matches[0];
            if (parent) {
                const saved = (await this.read(parent)).fm;
                if (saved.workflow_request_signature !== signature) throw new Error('请求参数已变化，请恢复原参数重试或使用新的 requestId');
                if (options.autoCreate !== false) await this.applyExisting(await this.previewExisting(parent, this.workflow(options)));
                await this.view.addProjectFromFile(parent, { ...options, title, silentNotice: true });
            } else parent = await this.transaction(tx => this.createOnce(title, { ...options, requestId, signature }, tx), requestId);
            this.state.attempts.delete(key);
            return parent;
        });
    }
    async createOnce(title, options = {}, tx) {
        title = String(title || '').trim();
        if (!title) throw new Error('请输入项目名称');
        const type = this.workflow(options);
        const parent = await this.createTask({ title,
            status: options.status || this.tn.settings.defaultTaskStatus,
            priority: options.priority || this.tn.settings.defaultTaskPriority,
            scheduled: options.scheduled || undefined, due: options.due || undefined,
            details: `${options.notes || ''}\n\n## 目标\n\n${type === 'sponsored-video' ? '## 合作基本信息\n\n' : ''}## 当前卡点\n`, customFrontmatter: { ...this.parentFields(type), workflow_request_id: options.requestId, workflow_request_signature: options.signature },
            creationContext: 'carrot-gantt-project' }, tx);
        tx.parent = parent;
        tx.parentPath = parent.path;
        // The parent lock spans the stage writes, the registration and the whole failure
        // cleanup of the enclosing transaction: while it is held, repair rejects instead of
        // adopting a stage file that a rollback is about to recycle.
        tx.releaseParentLock = this.holdParentLock(parent.path, `creating:${options.requestId}`);
        const stages = options.autoCreate === false ? [] : PROJECT_WORKFLOWS[type].stages.map((id, index) => ({ id, title: WORKFLOW_STAGES[id].title, order: index + 1, candidates: [] }));
        const children = await this.createStages(parent, type, title, options.priority || this.tn.settings.defaultTaskPriority, stages, tx);
        if (children.length) await this.writeLinks(parent, children, tx);
        await this.view.addProjectFromFile(parent, { ...options, title, silentNotice: true, workflowTransaction: tx });
        new Notice(`已创建项目「${title}」及 ${children.length} 个阶段任务`);
        return parent;
    }
    validateRegion(text) {
        const starts = text.split(WORKFLOW_START).length - 1;
        const ends = text.split(WORKFLOW_END).length - 1;
        if (starts !== ends || starts > 1 || (starts && text.indexOf(WORKFLOW_END) < text.indexOf(WORKFLOW_START))) throw new Error('项目正文生成区标记损坏或重复，请先人工修复');
    }
    async previewExisting(parent, type) {
        this.workflow({ workflow: type });
        if (!(parent instanceof TFile) || this.app.vault.getAbstractFileByPath(parent.path) !== parent) throw new Error('项目文件不存在');
        const current = await this.read(parent);
        this.validateRegion(current.body);
        const fields = this.fields();
        const title = String(current.fm[fields.title] || parent.basename);
        const snapshots = [];
        const stages = PROJECT_WORKFLOWS[type].stages.map((id, index) => ({ id, order: index + 1, title: WORKFLOW_STAGES[id].title, candidates: [] }));
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (file === parent) continue;
            const { fm, text } = await this.read(file);
            if (!(fields.status in fm)) continue;
            const refs = Array.isArray(fm[fields.projects]) ? fm[fields.projects] : [fm[fields.projects]];
            if (!refs.some(value => this.referencesParent(value, file, parent))) continue;
            const taskTitle = String(fm[fields.title] || file.basename);
            for (const stage of stages) {
                const aliases = stage.id === 'review' ? [stage.title, '初稿'] : [stage.title];
                const legacy = !fm.workflow_stage && aliases.some(name => taskTitle === name || [':', '：', '-'].some(separator => taskTitle === `${name}${separator}${title}`));
                if (fm.workflow_stage === stage.id || legacy) { stage.candidates.push({ path: file.path, title: taskTitle }); snapshots.push([file.path, text]); }
            }
        }
        const preview = { parentPath: parent.path, type, title, stages };
        this.state.previews.set(preview, JSON.stringify([parent.path, type, current.text, stages, snapshots.sort((a, b) => a[0].localeCompare(b[0])), fields]));
        return preview;
    }
    referencesParent(value, source, parent) {
        const parts = projectLinkParts(value);
        if (!parts.raw) return false;
        const target = parts.target;
        if (!target) return false;
        const path = target.endsWith('.md') ? target : `${target}.md`;
        if (path === parent.path) return true;
        if (target.includes('/')) {
            // `[[路径]]`, `[标题](路径.md)` and percent-encoded targets all resolve through
            // the same link cache as the rest of the plugin, so repair recognises a stage
            // that already exists instead of creating a duplicate. Paths are never guessed.
            return this.app.metadataCache.getFirstLinkpathDest(target, source.path) === parent;
        }
        const basename = target.replace(/\.md$/i, '');
        const matches = this.app.vault.getMarkdownFiles().filter(file => file.basename === basename);
        if (matches.length > 1 && matches.includes(parent)) throw new Error(`项目关联存在歧义：${source.path} → ${value}；请改成完整父项目路径`);
        return this.app.metadataCache.getFirstLinkpathDest(target, source.path) === parent;
    }
    async createStages(parent, type, title, priority, stages, tx) {
        const children = [];
        for (const stage of stages) {
            if (tx && (parent.path !== tx.parentPath || this.app.vault.getAbstractFileByPath(tx.parentPath) !== parent)) throw new Error('项目文件路径已变化，请重新预览');
            if (stage.candidates.length) {
                const candidate = stage.candidates[0];
                children.push({ file: this.app.vault.getAbstractFileByPath(candidate.path), title: candidate.title });
                continue;
            }
            const definition = WORKFLOW_STAGES[stage.id];
            const taskTitle = `${stage.title}：${title}`;
            const child = await this.createTask({ title: taskTitle, status: this.initialStatus(), priority,
                projects: [`[[${parent.path.replace(/\.md$/i, '')}]]`],
                details: definition.body + (stage.id === 'publish' && type === 'sponsored-video' ? '\n- [ ] 数据回传\n- [ ] 结算到账证据（发布完成不等于到账）\n- [ ] 归档检查' : ''),
                customFrontmatter: { workflow_stage: stage.id, workflow_order: stage.order }, creationContext: 'carrot-gantt-workflow' }, tx);
            children.push({ file: child, title: taskTitle });
        }
        return children;
    }
    applyExisting(preview) {
        return this.locked(`parent:${preview.parentPath}`, this.state.previews.get(preview), () => this.transaction(tx => this.applyExistingOnce(preview, tx)));
    }
    async applyExistingOnce(preview, tx) {
        const expected = this.state.previews.get(preview);
        if (!expected) throw new Error('请先显式预览流程');
        const parent = this.app.vault.getAbstractFileByPath(preview.parentPath);
        const fresh = await this.previewExisting(parent, preview.type);
        if (expected !== this.state.previews.get(fresh)) throw new Error('预览后内容已变化，请重新预览');
        preview = fresh;
        const conflicts = fresh.stages.filter(stage => stage.candidates.length > 1);
        if (conflicts.length) throw new Error(`阶段候选存在歧义，请用户先修正关联或阶段标识，再重新预览：${conflicts.map(stage => stage.candidates.map(c => c.path).join('、')).join('；')}`);
        const current = await this.read(parent);
        tx.parentPath = parent.path;
        const children = await this.createStages(parent, preview.type, preview.title,
            current.fm[this.fields().priority] || this.tn.settings.defaultTaskPriority, preview.stages, tx);
        if ((await this.read(parent)).text !== current.text) throw new Error('项目已被编辑，请重新预览');
        tx.touched.push({ file: parent, text: current.text });
        tx.existingParentBody = current.body;
        await this.app.fileManager.processFrontMatter(parent, fm => {
            if (JSON.stringify(fm) !== JSON.stringify(current.fm)) throw new Error('项目属性已被编辑，请重新预览');
            for (const [key, value] of Object.entries(this.parentFields(preview.type))) {
                if (['carrotProject', 'project_workflow', 'workflow_version'].includes(key) || fm[key] === undefined) fm[key] = value;
            }
        });
        if (children.length) await this.writeLinks(parent, children, tx);
        return { parent, createdCount: preview.stages.filter(stage => !stage.candidates.length).length };
    }
    async writeLinks(parent, children, tx) {
        if (tx && (parent.path !== tx.parentPath || this.app.vault.getAbstractFileByPath(tx.parentPath) !== parent)) throw new Error('项目文件路径已变化，请重新预览');
        const block = `${WORKFLOW_START}\n## 阶段任务\n${children.map(child => `- [[${child.file.path.replace(/\.md$/i, '')}|${child.title}]]`).join('\n')}\n${WORKFLOW_END}`;
        let writtenText;
        await this.app.vault.process(parent, text => {
            this.validateRegion(text);
            const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
            if (tx?.existingParentBody !== undefined && body !== tx.existingParentBody) throw new Error('项目正文已被编辑，请重新预览');
            const owned = tx?.created.find(record => record.file === parent);
            if (owned && (owned.text !== text || owned.mtime !== parent.stat?.mtime)) throw new Error('项目正文已被编辑，请重新预览');
            const start = text.indexOf(WORKFLOW_START);
            const end = text.indexOf(WORKFLOW_END);
            writtenText = start >= 0 && end > start ? text.slice(0, start) + block + text.slice(end + WORKFLOW_END.length) : `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
            return writtenText;
        });
        const owned = tx?.created.find(record => record.file === parent);
        if (owned) { owned.text = writtenText; owned.mtime = parent.stat?.mtime; }
    }
}

const MONTH_LABELS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const GANTT_TASK_SORT_MODES = new Set(['smart', 'manual', 'start', 'due', 'priority']);
const GANTT_PROJECT_SORT_MODES = new Set(['manual', 'urgent', 'due', 'start', 'created', 'name']);
const ARCHIVE_OVERRIDE_MS = 5000;
const DEFAULT_GANTT_SETTINGS = {
    cellWidth: 34,
    dataSource: 'dashboard',
    projects: [],
    taskSortMode: 'smart',
    taskOrder: {},
    projectSortMode: 'urgent',
    projectViewState: {},
    completedProjectsExpanded: false,
    showCompletedTasks: true,
    showWeekendShading: true,
    archivedProjectsExpanded: false,
    focusTodayOnOpen: true,
    rangePastDays: RANGE_PAST_DAYS,
    rangeFutureDays: RANGE_FUTURE_DAYS,
    timelineExtendDays: TIMELINE_EXTEND_DAYS
};

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseDate(value) {
    const text = String(value || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!m) return startOfDay(new Date());
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toYmd(date) {
    const d = startOfDay(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(value, includeYear = false) {
    const date = parseDate(value);
    const prefix = includeYear ? `${date.getFullYear()}/` : '';
    return `${prefix}${date.getMonth() + 1}/${date.getDate()}`;
}

function activateOnKeyboard(node, action) {
    if (!node || typeof action !== 'function') return;
    node.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        evt.preventDefault();
        evt.stopPropagation();
        action(evt);
    });
}

function replaceDatePart(original, nextDate) {
    const date = dateOnly(nextDate);
    if (!date) return '';
    const current = String(original ?? '').trim();
    const match = /^\d{4}-\d{2}-\d{2}(.*)$/.exec(current);
    return match ? `${date}${match[1]}` : date;
}

function positiveMinutes(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function taskNotesTimeline(scheduled, due, timeEstimate) {
    const scheduledRaw = String(scheduled ?? '').trim();
    const dueRaw = String(due ?? '').trim();
    const scheduledDate = dateOnly(scheduledRaw);
    const dueDate = dateOnly(dueRaw);
    const estimate = positiveMinutes(timeEstimate);
    let start = scheduledDate || dueDate || '';
    let end = start;
    let timelineMode = 'unscheduled';
    // Match TaskNotes Calendar: the scheduled event and the due event are two
    // independent objects. A scheduled bar gets its duration exclusively from
    // timeEstimate; due is rendered separately as a deadline marker.
    if (scheduledDate) {
        timelineMode = 'scheduled';
        const days = Math.max(1, Math.ceil(estimate / (24 * 60)));
        end = toYmd(addDays(parseDate(scheduledDate), days - 1));
    } else if (dueDate) {
        timelineMode = 'due-only';
        start = dueDate;
        end = dueDate;
    }
    return {
        scheduled: scheduledRaw,
        due: dueRaw,
        scheduledDate,
        dueDate,
        timeEstimate: estimate,
        start,
        end,
        timelineMode
    };
}

function addDays(date, days) {
    const d = parseDate(toYmd(date));
    d.setDate(d.getDate() + days);
    return d;
}

function diffDays(a, b) {
    return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function uid(prefix = 'gantt') {
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 9999)}`;
}

function el(parent, tag, cls, text) {
    const node = parent.createEl ? parent.createEl(tag) : document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (!node.parentElement && parent.appendChild) parent.appendChild(node);
    return node;
}

function normalisePath(path) {
    return String(path || '').replace(/^\/+/, '').replace(/\\/g, '/');
}

function extractMark(text, mark) {
    const idx = String(text || '').indexOf(mark);
    if (idx < 0) return null;
    let rest = text.slice(idx + mark.length);
    const next = rest.search(new RegExp(`[${TASK_MARKS}]`, 'u'));
    if (next >= 0) rest = rest.slice(0, next);
    return rest.trim() || null;
}

function dateOnly(value) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '').trim());
    return m ? m[1] : '';
}

function cleanTaskText(text) {
    return String(text || '').replace(META_RE, '').replace(/\s+\^[A-Za-z0-9_-]+(?=\s|$)/g, '').replace(/\s+/g, ' ').trim();
}

function displayTitle(text) {
    return cleanTaskText(text)
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?\]\]/g, (_m, p1) => p1.split('/').pop().replace(/\.md$/i, ''))
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .trim() || '未命名任务';
}

function linkedPathFromText(text) {
    const m = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/.exec(String(text || ''));
    return m ? m[1].replace(/\.md$/i, '').trim() : '';
}

function blockIdFromText(text) {
    const m = /(?:^|\s)\^([A-Za-z0-9_-]+)(?=\s|$)/.exec(String(text || ''));
    return m ? m[1] : '';
}

function setMark(text, mark, value) {
    const re = new RegExp(`${mark}[^\\n\\r${TASK_MARKS}]*`, 'gu');
    const stripped = String(text || '').replace(re, '').replace(/\s+/g, ' ').trim();
    return value ? `${stripped} ${mark} ${value}`.trim() : stripped;
}

function safeFilename(title) {
    return (String(title || '新任务').replace(/[\\/:*?"<>|#^\[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || '新任务').slice(0, 80);
}

function kanbanLinePrefix(line, done) {
    const m = /^(\s*[-*+]\s\[).(\]\s*)/.exec(line || '');
    return m ? `${m[1]}${done ? 'x' : ' '}${m[2]}` : `- [${done ? 'x' : ' '}] `;
}

function parseColumns(lines) {
    let footerStart = lines.length;
    for (let i = 0; i < lines.length; i++)
        if (FOOTER_RE.test(lines[i])) {
            footerStart = i;
            break;
        }
    let start = 0;
    if (lines[0]?.trim() === '---')
        for (let i = 1; i < footerStart; i++)
            if (lines[i].trim() === '---') {
                start = i + 1;
                break;
            }
    const columns = [];
    for (let i = start; i < footerStart; i++) {
        const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
        if (m) {
            if (columns.length) columns[columns.length - 1].endLine = i;
            columns.push({
                heading: m[1].trim(),
                headingLine: i,
                endLine: footerStart,
                tasks: []
            });
        }
    }
    return {
        columns,
        footerStart
    };
}

function taskBlockEnd(lines, lineNo) {
    const indent = (/^(\s*)/.exec(lines[lineNo])?.[1] || '').length;
    let end = lineNo + 1;
    while (end < lines.length) {
        const line = lines[end];
        const nextIndent = (/^(\s*)/.exec(line)?.[1] || '').length;
        if (line.trim() === '' || nextIndent <= indent) break;
        end++;
    }
    return end;
}

function descriptionLines(lines, lineNo) {
    const end = taskBlockEnd(lines, lineNo);
    return lines.slice(lineNo + 1, end).map((l) => l.replace(/^\s*(?:[-*+]\s+)?/, ''));
}

function indentedDescription(text, indent = '') {
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => `${indent}\t- ${l}`);
}

function inlineProject(rawBody) {
    const text = String(rawBody || '');
    const m = /(?:^|\s)(?:project|项目)::\s*([^\n\r\[\]#]+)/i.exec(text) || /\[(?:project|项目)::\s*([^\]]+)\]/i.exec(text);
    return m ? m[1].trim() : '';
}

// TaskNotes stores projects either as plain strings ("项目A") or as wikilinks
// to project notes ("[[项目A]]" / "[[项目A|别名]]"). Normalise any of those
// to the display title TaskNotes itself shows.
function projectTitleFromValue(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    let m = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/.exec(text);
    if (m) return (m[2] || m[1]).split('/').pop().replace(/\.md$/i, '').trim();
    m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text);
    if (m) return m[1].trim();
    return text;
}

function projectLinkParts(value) {
    const text = String(value ?? '').trim();
    if (!text) return { raw: '', target: '', alias: '', linked: false };
    let m = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/.exec(text);
    if (m) return { raw: text, target: m[1].replace(/\.md$/i, ''), alias: String(m[2] || '').trim(), linked: true };
    m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text);
    if (m) return { raw: text, target: safeDecodeURI(m[2]).replace(/\.md$/i, ''), alias: m[1].trim(), linked: true };
    return { raw: text, target: text.replace(/\.md$/i, ''), alias: '', linked: false };
}

function safeDecodeURI(value) {
    // Malformed percent-encoding in a task's projects value must not break the whole chart.
    try { return decodeURIComponent(value); } catch { return String(value); }
}

function defaultProjectsList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    const text = String(value ?? '').trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
        }
    } catch {}
    return text.split(/\r?\n|\s*,\s*/).map((item) => item.trim()).filter(Boolean);
}

class ProjectNotePickerModal extends FuzzySuggestModal {
    constructor(app, onChoose, allowCreate = false) {
        super(app);
        this.onChoose = onChoose;
        this.allowCreate = allowCreate;
        this.setPlaceholder(allowCreate ? '选择现有任务/笔记，或新建 TaskNotes 项目任务' : '选择要关联的项目任务或笔记');
    }
    getItems() {
        const files = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
        return this.allowCreate ? [{ create: true }, ...files] : files;
    }
    getItemText(item) {
        if (item?.create) return '＋ 新建 TaskNotes 项目任务';
        return item?.path || '';
    }
    onChooseItem(item) {
        Promise.resolve(this.onChoose?.(item)).catch((err) => console.error('Carrot Gantt project picker failed', err));
    }
}

class ProjectTaskCreateModal extends Modal {
    constructor(app, formOptions, onCreate) {
        super(app);
        this.formOptions = formOptions || {};
        this.onCreate = onCreate;
        this.submitting = false;
    }
    onOpen() {
        this.modalEl.addClass('carrot-gantt-project-create-modal');
        this.titleEl.setText('新建项目');
        const intro = el(this.contentEl, 'p', 'hg-project-create-desc', '设置项目的基础信息。项目本身会作为一条真实的 TaskNotes 任务创建，并显示在甘特图中。');
        intro.setAttribute('role', 'note');
        const field = el(this.contentEl, 'label', 'hg-field hg-project-create-field');
        el(field, 'span', '', '项目名称');
        const input = el(field, 'input', 'hg-input');
        input.type = 'text';
        input.placeholder = '例如：搭建工作台';
        input.autocomplete = 'off';

        const basics = el(this.contentEl, 'div', 'hg-project-create-grid');
        const makeSelect = (parent, label, items, selected) => {
            const selectField = el(parent, 'label', 'hg-field');
            el(selectField, 'span', '', label);
            const select = el(selectField, 'select', 'hg-input');
            for (const item of items || []) {
                const option = el(select, 'option', '', item.label || item.value);
                option.value = item.value;
            }
            select.value = selected || items?.[0]?.value || '';
            return select;
        };
        const statusInput = makeSelect(basics, '项目状态', this.formOptions.statuses, this.formOptions.defaultStatus);
        const priorityInput = makeSelect(basics, '优先级', this.formOptions.priorities, this.formOptions.defaultPriority);

        const taskTime = el(this.contentEl, 'section', 'hg-project-task-time');
        el(taskTime, 'div', 'hg-project-task-time-title', 'TaskNotes 时间');
        const dates = el(taskTime, 'div', 'hg-project-task-time-grid');
        const makeDate = (parent, label, value) => {
            const dateField = el(parent, 'label', 'hg-field');
            el(dateField, 'span', '', label);
            const control = el(dateField, 'span', 'hg-project-date-control');
            const date = el(control, 'input', 'hg-input hg-project-date-input');
            date.type = 'date';
            date.value = value || '';
            const picker = el(control, 'button', 'hg-project-date-picker');
            picker.type = 'button';
            picker.setAttribute('aria-label', `选择${label}`);
            setIcon(picker, 'calendar-days');
            picker.addEventListener('click', (event) => {
                event.preventDefault();
                date.focus();
                if (typeof date.showPicker === 'function') date.showPicker();
            });
            return { input: date, picker };
        };
        const scheduledField = makeDate(dates, '计划时间（scheduled）', this.formOptions.defaultScheduled);
        const dueField = makeDate(dates, '截止时间（due）', this.formOptions.defaultDue);
        const scheduledInput = scheduledField.input;
        const dueInput = dueField.input;
        el(taskTime, 'div', 'hg-project-task-time-hint', '与 TaskNotes 一致：计划时间决定任务开始，截止时间是独立期限提醒；日期可留空；阶段任务默认不排期，也不设置预计工时。');

        const colorField = el(this.contentEl, 'div', 'hg-field hg-project-create-color-field');
        el(colorField, 'span', '', '项目颜色');
        const colorPalette = el(colorField, 'div', 'hg-project-create-colors');
        let selectedColor = this.formOptions.defaultColor || DEFAULT_COLORS[0];
        const colorButtons = [];
        const syncColors = () => {
            for (const button of colorButtons) {
                const selected = button.dataset.color === selectedColor;
                button.toggleClass('is-selected', selected);
                button.setAttribute('aria-pressed', String(selected));
            }
        };
        for (const color of DEFAULT_COLORS) {
            const button = el(colorPalette, 'button', 'hg-project-create-color');
            button.type = 'button';
            button.dataset.color = color;
            button.style.setProperty('--preset-color', color);
            button.setAttribute('aria-label', `项目颜色 ${color}`);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                selectedColor = color;
                syncColors();
            });
            colorButtons.push(button);
        }
        syncColors();

        const notesField = el(this.contentEl, 'label', 'hg-field hg-project-create-notes-field');
        el(notesField, 'span', '', '备注');
        const notesInput = el(notesField, 'textarea', 'hg-input hg-textarea');
        notesInput.rows = 2;
        notesInput.placeholder = '项目目标、交付要求或其他说明（可选）';

        const workflowInput = makeSelect(this.contentEl, '项目类型', Object.entries(PROJECT_WORKFLOWS).map(([value, definition]) => ({ value, label: definition.label })), 'general');
        workflowInput.addClass('hg-project-workflow-select');
        const preview = el(this.contentEl, 'div', 'hg-workflow-preview');
        preview.setAttribute('aria-live', 'polite');
        const videoField = el(this.contentEl, 'label', 'hg-project-video-field');
        const videoInput = el(videoField, 'input', 'hg-project-video-checkbox');
        videoInput.type = 'checkbox';
        videoInput.checked = true;
        el(videoField, 'span', 'hg-project-video-copy', '自动创建阶段任务（不自动排期）');
        const syncWorkflow = () => {
            const definition = PROJECT_WORKFLOWS[workflowInput.value];
            preview.textContent = definition.stages.length ? definition.stages.map(id => WORKFLOW_STAGES[id].title).join(' → ') : '只创建父项目';
            videoField.hidden = !definition.stages.length;
        };
        workflowInput.addEventListener('change', syncWorkflow);
        syncWorkflow();
        const requestId = uid('workflow-request');
        const actions = el(this.contentEl, 'div', 'hg-popover-actions hg-project-create-actions');
        const cancel = el(actions, 'button', 'hg-button', '取消');
        const create = el(actions, 'button', 'hg-button hg-primary', '创建项目');
        const controls = [input, statusInput, priorityInput, scheduledInput, scheduledField.picker, dueInput, dueField.picker, notesInput, videoInput, workflowInput, ...colorButtons];
        const submit = async () => {
            const title = input.value.trim();
            if (!title || this.submitting) return;
            this.submitting = true;
            for (const control of controls) control.disabled = true;
            cancel.disabled = true;
            create.disabled = true;
            create.textContent = '创建中…';
            try {
                await this.onCreate?.(title, {
                    status: statusInput.value,
                    priority: priorityInput.value,
                    scheduled: scheduledInput.value,
                    due: dueInput.value,
                    color: selectedColor,
                    notes: notesInput.value.trim(),
                    workflow: workflowInput.value,
                    autoCreate: videoInput.checked,
                    requestId
                });
                this.close();
            } catch (err) {
                console.error('Carrot Gantt create project task failed', err);
                new Notice(`无法创建项目任务：${err?.message || err}`);
                this.submitting = false;
                for (const control of controls) control.disabled = false;
                cancel.disabled = false;
                create.disabled = false;
                create.textContent = '创建项目';
                input.focus();
            }
        };
        cancel.addEventListener('click', () => this.close());
        create.addEventListener('click', submit);
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
        });
        window.setTimeout(() => input.focus(), 0);
    }
    onClose() {
        this.contentEl.empty();
    }
}

class ProjectWorkflowModal extends Modal {
    constructor(app, service, file, initialType, onApplied) {
        super(app); this.service = service; this.file = file; this.initialType = initialType; this.onApplied = onApplied;
    }
    onOpen() {
        this.modalEl.addClass('carrot-gantt-project-create-modal');
        this.titleEl.setText('补齐流程子任务');
        el(this.contentEl, 'p', 'hg-project-create-desc', '只新增缺失阶段，保留旧任务正文、状态、计时与排期。类型变更不会删除旧阶段；有歧义时请先人工修正任务关联或阶段标识。');
        const label = el(this.contentEl, 'label', 'hg-field', '项目类型');
        const type = el(label, 'select', 'hg-input hg-project-workflow-select');
        for (const [value, definition] of Object.entries(PROJECT_WORKFLOWS)) el(type, 'option', '', definition.label).value = value;
        type.value = PROJECT_WORKFLOWS[this.initialType] ? this.initialType : 'general';
        const output = el(this.contentEl, 'div', 'hg-workflow-preview');
        output.setAttribute('aria-live', 'polite');
        const actions = el(this.contentEl, 'div', 'hg-popover-actions');
        const cancel = el(actions, 'button', 'hg-button', '取消');
        const previewButton = el(actions, 'button', 'hg-button', '预览流程');
        const confirm = el(actions, 'button', 'hg-button hg-primary', '确认补齐');
        confirm.disabled = true;
        let preview = null, busy = false, revision = 0;
        type.addEventListener('change', () => { revision++; preview = null; output.textContent = ''; confirm.disabled = true; });
        cancel.addEventListener('click', () => this.close());
        previewButton.addEventListener('click', async () => {
            if (busy) return;
            const generation = ++revision;
            confirm.disabled = true; preview = null;
            try {
                const next = await this.service.previewExisting(this.file, type.value);
                if (generation !== revision) return;
                preview = next;
                output.textContent = next.stages.length ? next.stages.map(stage =>
                    `${stage.order}. ${stage.title}：${stage.candidates.length > 1 ? '已存在多个候选，歧义（请先解决）' : stage.candidates.length ? '已存在' : '待创建'}${stage.candidates.map(c => `\n   ${c.path}`).join('')}`).join('\n') : '普通项目：只更新项目类型，不创建或删除阶段任务。';
                confirm.disabled = next.stages.some(stage => stage.candidates.length > 1);
            } catch (error) { output.textContent = error.message; }
        });
        confirm.addEventListener('click', async () => {
            if (!preview || confirm.disabled || busy) return;
            busy = true; confirm.disabled = true; previewButton.disabled = true; type.disabled = true; cancel.disabled = true;
            try {
                const result = await this.service.applyExisting(preview);
                new Notice(`已补齐 ${result.createdCount} 个阶段任务`);
                this.close();
                await this.onApplied?.();
            } catch (error) {
                output.textContent = error.message;
                preview = null; // Require a fresh, visible preview before retry.
            } finally { busy = false; previewButton.disabled = false; type.disabled = false; cancel.disabled = false; }
        });
    }
    onClose() { this.contentEl.empty(); }
}

function fmString(fm, keys) {
    if (!fm) return '';
    for (const key of keys) {
        const v = fm[key];
        if (Array.isArray(v)) return String(v[0] || '').trim();
        if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
}

function looksDoneColumn(name) {
    return /^(已完成|完成|done|归档|archive|archived)$/i.test(String(name || '').trim());
}

function frontmatterToYaml(fm) {
    let out = '---\n';
    for (const [key, value] of Object.entries(fm)) {
        if (value == null || value === '') continue;
        if (Array.isArray(value)) {
            if (!value.length) continue;
            out += `${key}:\n`;
            for (const v of value) out += `  - ${yamlScalar(v)}\n`;
        } else {
            out += `${key}: ${yamlScalar(value)}\n`;
        }
    }
    return `${out}---\n`;
}

function yamlScalar(value) {
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:[+-]\d{2}:\d{2}|Z)?)?$/.test(text)) return text;
    if (/^-?\d+(\.\d+)?$/.test(text)) return text;
    return JSON.stringify(text);
}

function bodyWithoutFrontmatter(content) {
    return String(content || '').replace(FRONTMATTER_RE, '')
        .replace(/^#{1,6}\s+.+(\r?\n|$)/, '')
        .trim();
}

class CarrotGanttSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Carrot Gantt' });
        containerEl.createEl('p', {
            text: '这些设置同时作用于独立甘特图和 Carrot Home 内嵌甘特图。工具栏中修改的数据源、排序和时间尺度也会同步到这里。',
            cls: 'setting-item-description'
        });

        containerEl.createEl('h3', { text: '数据与任务' });
        new Setting(containerEl)
            .setName('任务数据源')
            .setDesc('跟随当前 Carrot Home 的 Tasks 卡片，或直接读取全部 TaskNotes 任务。')
            .addDropdown((dropdown) => dropdown
                .addOption('dashboard', '当前 Dashboard 的 Tasks 卡片')
                .addOption('tasknotes', 'TaskNotes 全部任务')
                .setValue(this.plugin.settings.dataSource)
                .onChange((value) => this.plugin.updateSetting('dataSource', value, { focusToday: true, resetRange: true })));
        new Setting(containerEl)
            .setName('项目排序')
            .setDesc('置顶项目优先。临期优先按项目截止或下一项未完成任务的截止时间排列；手动顺序会保留。')
            .addDropdown((dropdown) => dropdown
                .addOption('urgent', '临期优先')
                .addOption('manual', '手动排序')
                .addOption('due', '项目截止日期')
                .addOption('start', '开始日期')
                .addOption('created', '最近创建')
                .addOption('name', '名称')
                .setValue(this.plugin.settings.projectSortMode)
                .onChange((value) => this.plugin.updateSetting('projectSortMode', value)));
        new Setting(containerEl)
            .setName('任务排序')
            .setDesc('智能排序会依次考虑完成状态、优先级、开始日期和截止日期。')
            .addDropdown((dropdown) => dropdown
                .addOption('smart', '智能排序')
                .addOption('manual', '手动排序')
                .addOption('start', '开始日期')
                .addOption('due', '截止日期')
                .addOption('priority', '优先级')
                .setValue(this.plugin.settings.taskSortMode)
                .onChange((value) => this.plugin.updateSetting('taskSortMode', value)));
        new Setting(containerEl)
            .setName('显示已完成任务')
            .setDesc('只隐藏任务条，项目总进度与完成判定仍按全部关联任务计算；当前 Dashboard 的过滤规则仍然优先。')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.showCompletedTasks !== false)
                .onChange((value) => this.plugin.updateSetting('showCompletedTasks', value, { resetRange: true })));

        containerEl.createEl('h3', { text: '时间轴与显示' });
        new Setting(containerEl)
            .setName('每日宽度')
            .setDesc('控制时间轴缩放密度；图表顶部的 ＋ / − 和双指缩放会同步更新。')
            .addSlider((slider) => slider
                .setLimits(MIN_CELL_WIDTH, MAX_CELL_WIDTH, 6)
                .setDynamicTooltip()
                .setValue(this.plugin.settings.cellWidth)
                .onChange((value) => this.plugin.updateSetting('cellWidth', value)));
        new Setting(containerEl)
            .setName('打开时定位到今天')
            .setDesc('新打开甘特图时，将今天放到可视区域中间。')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.focusTodayOnOpen !== false)
                .onChange((value) => this.plugin.updateSetting('focusTodayOnOpen', value, { focusToday: value })));
        new Setting(containerEl)
            .setName('突出显示周末')
            .setDesc('为周六和周日添加轻微底色，方便区分工作日。')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.showWeekendShading !== false)
                .onChange((value) => this.plugin.updateSetting('showWeekendShading', value)));
        new Setting(containerEl)
            .setName('今天之前的基础范围')
            .setDesc('即使没有更早任务，时间轴仍会在今天之前预留这些天数。')
            .addSlider((slider) => slider
                .setLimits(0, 180, 7)
                .setDynamicTooltip()
                .setValue(this.plugin.settings.rangePastDays)
                .onChange((value) => this.plugin.updateSetting('rangePastDays', value, { focusToday: true, resetRange: true })));
        new Setting(containerEl)
            .setName('今天之后的基础范围')
            .setDesc('即使没有更晚任务，时间轴仍会在今天之后预留这些天数。')
            .addSlider((slider) => slider
                .setLimits(14, 365, 1)
                .setDynamicTooltip()
                .setValue(this.plugin.settings.rangeFutureDays)
                .onChange((value) => this.plugin.updateSetting('rangeFutureDays', value, { focusToday: true, resetRange: true })));
        new Setting(containerEl)
            .setName('滑到边缘时扩展天数')
            .setDesc('时间轴滑到最左或最右后，每次继续加载的日期范围。')
            .addSlider((slider) => slider
                .setLimits(15, 180, 15)
                .setDynamicTooltip()
                .setValue(this.plugin.settings.timelineExtendDays)
                .onChange((value) => this.plugin.updateSetting('timelineExtendDays', value)));
    }
}

class CarrotGanttPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({
            ...DEFAULT_GANTT_SETTINGS,
            projects: [],
            taskOrder: {},
            projectViewState: {}
        }, await this.loadData());
        let migratedSource = false;
        if (this.settings.dataSource === 'kanban') {
            this.settings.dataSource = 'dashboard';
            migratedSource = true;
        }
        if ('kanbanFile' in this.settings) {
            delete this.settings.kanbanFile;
            migratedSource = true;
        }
        if (migratedSource) await this.saveData(this.settings);
        if (!Array.isArray(this.settings.projects)) this.settings.projects = [];
        if (!GANTT_TASK_SORT_MODES.has(this.settings.taskSortMode)) this.settings.taskSortMode = 'smart';
        if (!GANTT_PROJECT_SORT_MODES.has(this.settings.projectSortMode)) this.settings.projectSortMode = 'urgent';
        if (!this.settings.projectViewState || typeof this.settings.projectViewState !== 'object' || Array.isArray(this.settings.projectViewState)) this.settings.projectViewState = {};
        if (!this.settings.taskOrder || typeof this.settings.taskOrder !== 'object' || Array.isArray(this.settings.taskOrder)) this.settings.taskOrder = {};
        this.settings.cellWidth = clamp(Number(this.settings.cellWidth || 34), MIN_CELL_WIDTH, MAX_CELL_WIDTH);
        this.settings.rangePastDays = clamp(Math.round(Number(this.settings.rangePastDays ?? RANGE_PAST_DAYS)), 0, 180);
        this.settings.rangeFutureDays = clamp(Math.round(Number(this.settings.rangeFutureDays ?? RANGE_FUTURE_DAYS)), 14, 365);
        this.settings.timelineExtendDays = clamp(Math.round(Number(this.settings.timelineExtendDays ?? TIMELINE_EXTEND_DAYS)), 15, 180);
        this.registerView(VIEW_TYPE, (leaf) => new GanttView(leaf, this));
        this.addSettingTab(new CarrotGanttSettingTab(this.app, this));
        this.addRibbonIcon('chart-gantt', '打开 Carrot Gantt', () => this.activateView());
        this.addCommand({
            id: 'open-carrot-gantt',
            name: '打开 Carrot Gantt',
            callback: () => this.activateView()
        });
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    async updateSetting(key, value, options = {}) {
        this.settings[key] = value;
        await this.saveSettings();
        await this.refreshGanttViews(options);
    }
    async refreshGanttViews({ focusToday = false, resetRange = false } = {}) {
        const views = [...new Set([...(this.ganttViews || []), ...this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => leaf.view)])]
            .filter((view) => view instanceof GanttView && view.contentEl?.isConnected);
        for (const view of views) {
            if (resetRange) {
                view.timelineExtraPast = 0;
                view.timelineExtraFuture = 0;
            }
            if (focusToday) view.shouldScrollToday = true;
            await view.render();
        }
    }
    async activateView() {
        // Reuse a fully opened standalone Gantt tab when possible. Carrot Home
        // may retain unrendered helper leaves for embedded cards, so checking
        // containerEl alone is not enough to distinguish a real workspace tab.
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)
            .find((candidate) => candidate.view?.rootEl?.isConnected
                && !candidate.view.rootEl.closest?.('.hearth-card'));
        if (!leaf) {
            try {
                leaf = this.app.workspace.getLeaf('tab');
            } catch {
                leaf = this.app.workspace.getLeaf(true);
            }
            await leaf.setViewState({
                type: VIEW_TYPE,
                active: true
            });
        }
        await this.app.workspace.revealLeaf(leaf);
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }
    refreshCarrotHome() {
        try {
            const carrot = this.app.plugins?.plugins?.['carrot-home'];
            if (typeof carrot?.refreshDataCards === 'function') carrot.refreshDataCards(['tasks', 'schedule']);
            else carrot?.refreshViews?.();
        } catch {}
    }
}

class GanttView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.popover = null;
        this.shouldScrollToday = this.plugin.settings.focusTodayOnOpen !== false;
        this.board = null;
        this.renderSeq = 0;
        this.tnCompleted = 'done';
        this.tnOpen = 'open';
        this.tnStatusesCompleted = new Set(['done']);
        this.tn = null;
        this.compactDashboardMode = null;
        this.responsiveObserver = null;
        this.activeDragCleanups = new Set();
        this.internalWriteCounts = new Map();
        this.internalWriteReleaseTimers = new Set();
        this.pendingTaskDateOverrides = new Map();
        this.projectOrderDragId = null;
        this.taskOrderDrag = null;
        this.timelineExtraPast = 0;
        this.timelineExtraFuture = 0;
        this.timelineExtending = false;
        this.pendingTimelineRangeRestore = null;
    }
    getViewType() {
        return VIEW_TYPE;
    }
    getDisplayText() {
        return '项目甘特图';
    }
    getIcon() {
        return 'chart-gantt';
    }
    async onOpen() {
        this.plugin.ganttViews ||= new Set();
        this.plugin.ganttViews.add(this);
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (this.isInternalWrite(file)) return;
            if (file instanceof TFile && ((this.board?.mode === 'tasknotes' && this.isTaskNotesTaskFile(file)) || this.board?.projects?.some((p) => p.notePath === file.path) || this.board?.file?.path === file.path || this.board?.tasks?.some((t) => t.linkedFile?.path === file.path || t.file?.path === file.path))) this.scheduleRender();
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            const internalWrite = this.isInternalWrite(file, oldPath);
            this.migrateProjectViewState(file, oldPath)
                .catch((error) => console.error('Carrot Gantt project view state rename failed', error))
                .finally(() => {
                    if (!internalWrite && file instanceof TFile && (this.board?.mode === 'tasknotes' || this.board?.file?.path === file.path || this.board?.file?.path === oldPath || this.board?.tasks?.some((t) => t.file?.path === file.path || t.file?.path === oldPath))) this.scheduleRender();
                });
        }));
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (this.board?.mode === 'tasknotes' && this.isTaskNotesTaskFile(file)) this.scheduleRender();
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            this.handleVaultDelete(file).catch((err) => console.error('Carrot Gantt deleted-file cleanup failed', err));
        }));
        this.observeResponsiveMode();
        await this.render();
    }
    isTaskNotesTaskFile(file, frontmatter = null) {
        if (!(file instanceof TFile) || !file.path.endsWith('.md')) return false;
        const taskNotes = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const settings = taskNotes?.settings || this.tn || {};
        const cache = taskNotes?.cacheManager;
        const fm = frontmatter || this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm || typeof fm !== 'object') return false;
        // TaskNotes owns task identity, including excluded folders. A status
        // property or placement in the task folder does not make a note a task.
        try {
            if (typeof cache?.isValidFile === 'function' && cache.isValidFile(file.path) === false) return false;
        } catch {}
        const excluded = Array.isArray(settings.excludedFolders) ? settings.excludedFolders : String(settings.excludedFolders || '').split(',');
        if (excluded.map((value) => normalisePath(String(value).trim())).filter(Boolean)
            .some((folder) => file.path === folder || file.path.startsWith(`${folder}/`))) return false;
        try {
            const identified = cache?.isTaskFile?.(fm);
            if (typeof identified === 'boolean') return identified;
        } catch {}
        if (settings.taskIdentificationMethod === 'property') {
            const property = settings.taskPropertyName;
            const expected = settings.taskPropertyValue;
            if (!property || expected == null || expected === '') return false;
            const matches = (value) => typeof value === 'boolean' && /^(true|false)$/i.test(String(expected))
                ? value === (String(expected).toLowerCase() === 'true') : value === expected;
            return Array.isArray(fm[property]) ? fm[property].some(matches) : matches(fm[property]);
        }
        if (settings.taskIdentificationMethod === 'tag' || settings.taskTag) {
            const normalizeTag = (value) => String(value || '').trim().replace(/^#/, '').trim().replace(/\s+/g, '-').toLowerCase();
            const tag = normalizeTag(settings.taskTag || 'task');
            const tags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === 'string' ? [fm.tags] : [];
            return tags.some((value) => { const actual = normalizeTag(value); return actual === tag || actual.startsWith(`${tag}/`); });
        }
        // Compatibility for older TaskNotes integrations that expose neither
        // the identity API nor identification settings.
        const statusField = this.taskNotesFields()?.status || 'status';
        return statusField in fm;
    }
    async handleVaultDelete(file) {
        const deletedPath = normalisePath(file?.path || '');
        if (!deletedPath || !deletedPath.endsWith('.md')) return;
        const stored = this.plugin.settings.projects || [];
        const deletedKey = `file:${deletedPath}`;
        const next = stored.filter((project) => {
            const notePath = normalisePath(project?.notePath || project?.path || '');
            return notePath !== deletedPath && String(project?.key || '') !== deletedKey;
        });
        const removedStoredProject = next.length !== stored.length;
        const removedVisibleProject = this.board?.projects?.some((project) =>
            normalisePath(project?.notePath || '') === deletedPath || String(project?.key || '') === deletedKey
        );
        const removedVisibleTask = this.board?.tasks?.some((task) => task.file?.path === deletedPath)
            || this.board?.projects?.some((project) => this.projectAllTasks(project).some((task) => task.file?.path === deletedPath));
        if (removedStoredProject) {
            this.plugin.settings.projects = next;
            await this.plugin.saveSettings();
        }
        if (this.board?.mode === 'tasknotes' && (removedStoredProject || removedVisibleProject || removedVisibleTask)) {
            this.plugin.refreshCarrotHome();
            this.scheduleRender();
        }
    }
    async onClose() {
        this.plugin.ganttViews?.delete(this);
        clearTimeout(this.projectSearchTimer);
        this._taskBodyCache?.clear();
        this._taskBodyReads?.clear();
        this._taskBodyCache = null;
        this._taskBodyReads = null;
        this._taskBodyCacheChars = 0;
        this._taskBodyCachePrunedAt = null;
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        for (const cleanup of [...this.activeDragCleanups]) {
            try { cleanup(true, false); } catch {}
        }
        this.activeDragCleanups.clear();
        for (const timer of this.internalWriteReleaseTimers) window.clearTimeout(timer);
        this.internalWriteReleaseTimers.clear();
        this.internalWriteCounts.clear();
        this.pendingTaskDateOverrides.clear();
        this.responsiveObserver?.disconnect();
        this.responsiveObserver = null;
        this.closePopover();
        this.clearCompactHomeEntry();
        this.contentEl.empty();
    }

    clearCompactHomeEntry() {
        const body = this.contentEl.closest?.('.hearth-card-body');
        const card = this.contentEl.closest?.('.hearth-card');
        if (this.compactEntryEl?.isConnected) this.compactEntryEl.remove();
        if (body) {
            body.classList.remove('hg-compact-entry-body');
        }
        card?.classList.remove('has-gantt-compact-entry');
        this.compactEntryEl = null;
    }

    attachCompactEntryToHomeCard(entry) {
        const body = this.contentEl.closest?.('.hearth-card-body');
        const card = this.contentEl.closest?.('.hearth-card');
        if (!body || !card) return false;
        body.classList.add('hg-compact-entry-body');
        card.classList.add('has-gantt-compact-entry');
        this.compactEntryEl = entry;
        return true;
    }
    scheduleRender() {
        clearTimeout(this.refreshTimer);
        if (this.activeDragCleanups.size || this.internalWriteCounts.size) {
            this.refreshTimer = window.setTimeout(() => this.scheduleRender(), 240);
            return;
        }
        this.refreshTimer = window.setTimeout(() => this.render(), 180);
    }

    internalWritePath(value) {
        return typeof value === 'string' ? value : value?.path;
    }
    isInternalWrite(file, oldPath = '') {
        const path = this.internalWritePath(file);
        return (path && (this.internalWriteCounts.get(path) || 0) > 0) ||
            (oldPath && (this.internalWriteCounts.get(oldPath) || 0) > 0);
    }
    beginInternalWrite(...values) {
        const paths = new Set();
        const add = (value) => {
            const path = this.internalWritePath(value);
            if (!path || paths.has(path)) return;
            paths.add(path);
            this.internalWriteCounts.set(path, (this.internalWriteCounts.get(path) || 0) + 1);
        };
        values.forEach(add);
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        let released = false;
        return {
            add,
            release: (delay = 420) => {
                if (released) return;
                released = true;
                const timer = window.setTimeout(() => {
                    this.internalWriteReleaseTimers.delete(timer);
                    for (const path of paths) {
                        const next = (this.internalWriteCounts.get(path) || 1) - 1;
                        if (next > 0) this.internalWriteCounts.set(path, next);
                        else this.internalWriteCounts.delete(path);
                    }
                }, delay);
                this.internalWriteReleaseTimers.add(timer);
            }
        };
    }

    isCompactDashboardMode() {
        const dashboard = this.contentEl.closest?.('.hearth-dashboard');
        // Responsive behavior is driven by the space actually available to the
        // Gantt view, not by a desktop/mobile platform flag. Embedded charts use
        // the dashboard width; a standalone chart uses its own view width. This
        // keeps phone landscape on the regular layout and switches phone portrait
        // (or any genuinely narrow pane) to the compact, horizontally scrollable
        // layout without maintaining a separate Mobile Dashboard.
        const container = dashboard || this.contentEl;
        const width = container?.getBoundingClientRect?.().width || container?.clientWidth || 0;
        return width > 0 && width <= COMPACT_DASHBOARD_BREAKPOINT;
    }

    observeResponsiveMode() {
        const dashboard = this.contentEl.closest?.('.hearth-dashboard');
        const container = dashboard || this.contentEl;
        if (!container || typeof ResizeObserver === 'undefined') return;
        this.compactDashboardMode = this.isCompactDashboardMode();
        this.responsiveObserver = new ResizeObserver(() => {
            const next = this.isCompactDashboardMode();
            if (next === this.compactDashboardMode) return;
            this.compactDashboardMode = next;
            this.scheduleRender();
        });
        this.responsiveObserver.observe(container);
    }

    async getCarrotHomeSettings() {
        const live = this.app.plugins?.plugins?.['carrot-home']?.settings;
        if (live) return live;
        try {
            return JSON.parse(await this.app.vault.adapter.read('.obsidian/plugins/carrot-home/data.json'));
        } catch {
            return null;
        }
    }
    homeViewContentSelector() {
        return '.workspace-leaf-content[data-type="carrot-home-view"] .view-content';
    }
    async getTaskNotesSettings() {
        const live = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID]?.settings;
        if (live) return live;
        try {
            return JSON.parse(await this.app.vault.adapter.read('.obsidian/plugins/tasknotes/data.json'));
        } catch {
            return null;
        }
    }
    taskNotesFields(tn = this.tn, carrotHome = null) {
        const mapping = tn?.fieldMapping || {};
        const field = (name, fallback) => String(mapping[name] || fallback || name).trim() || fallback || name;
        return {
            title: field('title', 'title'),
            status: field('status', carrotHome?.taskNotesStatusField || 'status'),
            priority: field('priority', 'priority'),
            scheduled: field('scheduled', 'scheduled'),
            due: field('due', carrotHome?.taskNotesDueField || 'due'),
            timeEstimate: field('timeEstimate', 'timeEstimate'),
            projects: field('projects', 'projects'),
            completedDate: field('completedDate', 'completedDate'),
            dateCreated: field('dateCreated', 'dateCreated'),
            dateModified: field('dateModified', 'dateModified')
        };
    }
    taskNotesPriorityOptions(currentValue = '') {
        const configured = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID]?.settings?.customPriorities;
        const source = Array.isArray(configured) && configured.length
            ? configured
            : [
                { value: 'none', label: 'None' },
                { value: 'low', label: 'Low' },
                { value: 'normal', label: 'Normal' },
                { value: 'high', label: 'High' }
            ];
        const knownLabels = {
            none: '无',
            lowest: '最低',
            low: '低',
            medium: '普通',
            normal: '普通',
            high: '高',
            highest: '最高'
        };
        const options = [];
        const seen = new Set();
        for (const item of source) {
            const value = String(item?.value ?? item?.id ?? '').trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            const label = knownLabels[value.toLowerCase()] || String(item?.label || value).trim() || value;
            options.push({ value, label });
        }
        const current = String(currentValue || '').trim();
        if (current && !seen.has(current)) options.push({ value: current, label: `当前值：${current}` });
        return options;
    }
    taskNotesStatusOptions(currentValue = '') {
        const configured = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID]?.settings?.customStatuses;
        const source = Array.isArray(configured) && configured.length
            ? configured.slice().sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
            : [
                { value: 'none', label: 'None' },
                { value: 'open', label: 'Open' },
                { value: 'in-progress', label: 'In progress' },
                { value: 'done', label: 'Done' }
            ];
        const options = [];
        const seen = new Set();
        for (const item of source) {
            const value = String(item?.value ?? item?.id ?? '').trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            options.push({ value, label: String(item?.label || value).trim() || value });
        }
        const current = String(currentValue || '').trim();
        if (current && !seen.has(current)) options.push({ value: current, label: `当前值：${current}` });
        return options;
    }
    isTaskNotesEnabled() {
        return !!this.app.plugins?.enabledPlugins?.has(TASKNOTES_PLUGIN_ID);
    }
    getTaskRepository() {
        return this.app.plugins?.plugins?.['carrot-home']?.taskRepository || globalThis.__carrotHomeTaskRepository || null;
    }
    currentDashboardTaskCard(settings) {
        const dashboards = settings?.dashboards || [];
        const dashboard = dashboards.find((item) => item.id === settings?.activeDashboardId) || dashboards[0] || null;
        return {
            dashboard,
            card: dashboard?.cards?.find((item) => item.kind === 'tasks') || null
        };
    }
    taskPathMatchesSource(path, cfg) {
        const mode = cfg?.folderScope || 'all';
        if (mode === 'all') return true;
        const folders = (cfg?.folders || []).map(normalisePath).filter(Boolean);
        const inside = folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
        return mode === 'whitelist' ? inside : !inside;
    }
    taskPriorityBucket(value) {
        const priority = String(value || '').trim().toLowerCase();
        if (!priority) return 'none';
        if (/^(high|urgent|critical|highest|p1|1|!!!|🔺|⏫)$/.test(priority)) return 'high';
        if (/^(medium|normal|med|moderate|p2|2|🔼)$/.test(priority)) return 'medium';
        if (/^(low|lowest|minor|p3|3|🔽|⏬)$/.test(priority)) return 'low';
        return 'none';
    }
    taskPriorityRank(value) {
        const priority = String(value || '').trim().toLowerCase();
        if (priority === 'highest' || priority === '🔺') return 0;
        if (/^(high|urgent|critical|p1|1|!!!|⏫)$/.test(priority)) return 1;
        if (/^(medium|normal|med|moderate|p2|2|🔼)$/.test(priority)) return 2;
        if (/^(low|minor|p3|3|🔽)$/.test(priority)) return 3;
        if (priority === 'lowest' || priority === '⏬') return 4;
        return 5;
    }
    taskSourceDate(task) {
        return String(task?.due || task?.scheduled || '').trim() || null;
    }
    dashboardTaskDone(status, cfg, carrotHome) {
        const configured = (Array.isArray(cfg?.taskNotesDoneStatuses) ? cfg.taskNotesDoneStatuses : [])
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean);
        const doneStatuses = new Set(configured.length ? configured : [String(carrotHome?.taskNotesDoneValue || 'done').trim().toLowerCase() || 'done']);
        return doneStatuses.has(String(status || '').trim().toLowerCase());
    }
    taskMatchesDashboardFilter(task, filter, today) {
        if (!filter || typeof filter !== 'object') return true;
        if (Array.isArray(filter.statuses) && filter.statuses.length) {
            const status = String(task.status || '').trim().toLowerCase();
            if (!filter.statuses.some((value) => String(value || '').trim().toLowerCase() === status)) return false;
        }
        if (Array.isArray(filter.priorities) && filter.priorities.length
            && !filter.priorities.includes(this.taskPriorityBucket(task.priority))) return false;
        if (filter.due) {
            const sourceDate = this.taskSourceDate(task);
            const date = sourceDate ? sourceDate.slice(0, 10) : null;
            if (filter.due === 'hasDate' && !date) return false;
            if (filter.due === 'noDate' && date) return false;
            if (filter.due === 'overdue' && !(date && date < today && !task.done)) return false;
            if (filter.due === 'today' && date !== today) return false;
            if (filter.due === 'week') {
                const weekEnd = toYmd(addDays(parseDate(today), 7));
                if (!(date && date >= today && date <= weekEnd)) return false;
            }
        }
        const text = String(filter.text || '').trim().toLowerCase();
        if (text && !String(task.title || task.file?.basename || '').toLowerCase().includes(text)) return false;
        return true;
    }
    compareTaskField(a, b, field) {
        const compareNullable = (left, right) => left && right
            ? (left < right ? -1 : left > right ? 1 : 0)
            : (left ? -1 : right ? 1 : 0);
        if (field === 'due') return compareNullable(this.taskSourceDate(a), this.taskSourceDate(b));
        if (field === 'scheduled') return compareNullable(a.scheduled, b.scheduled);
        if (field === 'priority') return this.taskPriorityRank(a.priority) - this.taskPriorityRank(b.priority);
        if (field === 'created') return Number(a.created || 0) - Number(b.created || 0);
        if (field === 'alpha') return String(a.title || a.file?.basename || '').localeCompare(String(b.title || b.file?.basename || ''), 'zh-Hans-CN');
        if (field === 'status') return String(a.status || '').toLowerCase().localeCompare(String(b.status || '').toLowerCase());
        return 0;
    }
    compareTasksSmart(a, b) {
        if (a.due && b.due) {
            if (a.due < b.due) return -1;
            if (a.due > b.due) return 1;
        } else if (a.due) return -1;
        else if (b.due) return 1;
        if (a.scheduled && b.scheduled) {
            if (a.scheduled < b.scheduled) return -1;
            if (a.scheduled > b.scheduled) return 1;
        } else if (a.scheduled) return -1;
        else if (b.scheduled) return 1;
        const priority = this.taskPriorityRank(a.priority) - this.taskPriorityRank(b.priority);
        return priority !== 0 ? priority : Number(a.created || 0) - Number(b.created || 0);
    }
    sortDashboardTasks(tasks, cfg) {
        const rules = Array.isArray(cfg?.sortRules) ? cfg.sortRules.filter((rule) => rule?.field) : [];
        const reverse = !!cfg?.sortReverse;
        return tasks.sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            if (rules.length) {
                for (const rule of rules) {
                    const compared = this.compareTaskField(a, b, rule.field);
                    if (compared !== 0) return rule.reverse ? -compared : compared;
                }
                return Number(a.created || 0) - Number(b.created || 0);
            }
            const key = cfg?.sortKey || 'smart';
            let compared;
            if (key === 'priority') {
                compared = this.compareTaskField(a, b, 'priority');
                if (compared === 0) compared = this.compareTasksSmart(a, b);
            } else if (key === 'created' || key === 'alpha') compared = this.compareTaskField(a, b, key);
            else if (key === 'due') {
                compared = this.compareTaskField(a, b, 'due');
                if (compared === 0) compared = Number(a.created || 0) - Number(b.created || 0);
            } else compared = this.compareTasksSmart(a, b);
            return reverse ? -compared : compared;
        });
    }
    applyDashboardTaskConfig(tasks, cfg) {
        let visible = this.sortDashboardTasks(tasks.slice(), cfg || {});
        if ((cfg?.layout || 'list') === 'kanban') {
            const hidden = new Set((Array.isArray(cfg?.kanbanHidden) ? cfg.kanbanHidden : [])
                .map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
            if (hidden.size) visible = visible.filter((task) => !hidden.has(String(task.status || 'none').trim().toLowerCase() || 'none'));
            return visible;
        }
        if (cfg?.showCompleted !== true) visible = visible.filter((task) => !task.done);
        if (cfg?.taskFilter && typeof cfg.taskFilter === 'object') {
            const today = toYmd(new Date());
            visible = visible.filter((task) => this.taskMatchesDashboardFilter(task, cfg.taskFilter, today));
        }
        const limit = Number(cfg?.count) > 0 ? Math.floor(Number(cfg.count)) : 10;
        return visible.slice(0, limit);
    }
    // Carrot Gantt may read TaskNotes settings to respect its field mapping,
    // but it must never mutate TaskNotes' plugin settings or data.json.
    taskNotesCompletedStatus(tn) {
        const sts = Array.isArray(tn?.customStatuses) ? tn.customStatuses : [];
        const found = sts.find((s) => s.isCompleted);
        return found ? String(found.value || 'done') : 'done';
    }
    taskNotesOpenStatus(tn) {
        const sts = Array.isArray(tn?.customStatuses) ? tn.customStatuses : [];
        const found = sts.find((s) => !s.isCompleted);
        return found ? String(found.value || 'open') : 'open';
    }
    isCompletedStatusValue(status) {
        return this.tnStatusesCompleted.has(String(status || '').trim().toLowerCase());
    }
    async getTaskSource() {
        const settings = await this.getCarrotHomeSettings();
        const tnEnabled = this.isTaskNotesEnabled();
        const preference = ['dashboard', 'tasknotes'].includes(this.plugin.settings.dataSource)
            ? this.plugin.settings.dataSource : 'dashboard';
        const repositorySource = this.getTaskRepository()?.currentDashboardTaskSource?.(settings);
        const current = repositorySource ? {
            dashboard: repositorySource.dashboard,
            card: repositorySource.card
        } : this.currentDashboardTaskCard(settings);
        const cfg = current.card?.tasks || null;

        if (preference === 'tasknotes') {
            if (!tnEnabled) return { mode: 'unavailable', reason: 'TaskNotes 当前未启用，无法读取全部任务。' };
            return {
                mode: 'tasknotes', file: null, taskConfig: null,
                origin: 'override'
            };
        }

        // Dashboard mode is deliberately strict: only the Tasks card on the active
        // Dashboard may define the source. Never disguise a missing or unsupported
        // card as "当前 Dashboard" while silently loading every TaskNotes task.
        if (!settings || !current.dashboard) return {
            mode: 'unavailable', reason: '无法读取当前 Dashboard。请先打开或创建一个 Carrot Home Dashboard。'
        };
        if (!current.card || !cfg) return {
            mode: 'unavailable', reason: `当前 Dashboard「${current.dashboard.name || '未命名'}」没有 Tasks 卡片。`
        };
        if (cfg.source !== 'tasknotes') return {
            mode: 'unavailable', reason: '当前 Dashboard 的 Tasks 卡片不是 TaskNotes 数据源。请将其改为 TaskNotes，或切换到「TaskNotes 全部任务」。'
        };
        if (!tnEnabled) return {
            mode: 'unavailable', reason: '当前 Dashboard 使用 TaskNotes，但 TaskNotes 插件尚未启用。'
        };
        return {
            mode: 'tasknotes', file: null, taskConfig: cfg,
            origin: 'dashboard', dashboardId: current.dashboard.id || ''
        };
    }
    resolveLinkedFileFromTarget(target) {
        if (!target) return null;
        try {
            return this.app.metadataCache.getFirstLinkpathDest(target, this.board?.file?.path || '') || null;
        } catch {
            return null;
        }
    }
    resolveLinkedFile(task) {
        if (this.board?.mode === 'tasknotes' && task.file instanceof TFile) return task.file;
        return this.resolveLinkedFileFromTarget(task.linkTarget);
    }
    getLinkedFrontmatter(file) {
        return file instanceof TFile ? (this.app.metadataCache.getFileCache(file)?.frontmatter || null) : null;
    }
    isProjectMarkerValue(value) {
        if (value === true || value === 1) return true;
        return /^(true|yes|1|project|项目)$/i.test(String(value ?? '').trim());
    }
    projectTitleForFile(file) {
        if (!(file instanceof TFile)) return '';
        const fm = this.getLinkedFrontmatter(file);
        return this.taskNotesTitleForFile(file, fm);
    }
    taskNotesTitleForFile(file, frontmatter = null, taskInfo = null) {
        if (!(file instanceof TFile)) return '';
        const titleField = this.taskNotesFields()?.title || 'title';
        const propertyTitle = frontmatter?.[titleField] ?? frontmatter?.title;
        const runtimeTask = taskInfo || this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID]?.cacheManager?.getCachedTaskInfoSync?.(file.path);
        return String(propertyTitle ?? runtimeTask?.title ?? file.basename).trim() || file.basename;
    }
    getTaskProject(rawBody, linkedFile) {
        const fm = this.getLinkedFrontmatter(linkedFile);
        return fmString(fm, ['project', '项目', 'projects']) || inlineProject(rawBody) || UNASSIGNED_PROJECT;
    }
    projectRefFromValue(value, sourceFile = null) {
        const parts = projectLinkParts(value);
        if (!parts.raw) return null;
        const sourcePath = sourceFile instanceof TFile ? sourceFile.path : String(sourceFile?.path || sourceFile || '');
        let file = null;
        try {
            file = this.app.metadataCache.getFirstLinkpathDest(parts.target, sourcePath) || null;
        } catch {}
        if (file instanceof TFile) {
            return {
                key: `file:${file.path}`,
                title: parts.alias || this.projectTitleForFile(file),
                notePath: file.path,
                rawValue: parts.raw,
                sourceType: this.isTaskNotesTaskFile(file) ? 'task' : 'note'
            };
        }
        if (parts.linked) return null;
        const title = projectTitleFromValue(parts.raw);
        if (!title) return null;
        return {
            key: `raw:${title.toLocaleLowerCase('zh-Hans-CN')}`,
            title,
            notePath: '',
            rawValue: parts.raw,
            sourceType: 'value'
        };
    }
    projectRefFromFile(file, sourceFile = null) {
        if (!(file instanceof TFile)) return null;
        const currentFile = this.app.vault.getAbstractFileByPath(file.path);
        if (!(currentFile instanceof TFile)) return null;
        file = currentFile;
        const sourcePath = sourceFile instanceof TFile ? sourceFile.path : String(sourceFile?.path || sourceFile || '');
        const rawValue = this.app.fileManager.generateMarkdownLink(file, sourcePath);
        return {
            key: `file:${file.path}`,
            title: this.projectTitleForFile(file),
            notePath: file.path,
            rawValue,
            sourceType: this.isTaskNotesTaskFile(file) ? 'task' : 'note'
        };
    }
    projectValueForTask(project, taskFile = null) {
        if (!project || project.title === UNASSIGNED_PROJECT) return '';
        const notePath = normalisePath(project.notePath || (String(project.key || '').startsWith('file:') ? String(project.key).slice(5) : ''));
        const note = notePath ? this.app.vault.getAbstractFileByPath(notePath) : null;
        if (note instanceof TFile) {
            const sourcePath = taskFile instanceof TFile ? taskFile.path : String(taskFile?.path || taskFile || '');
            return this.app.fileManager.generateMarkdownLink(note, sourcePath);
        }
        return String(project.rawValue || project.title || '').trim();
    }
    taskBelongsToProject(task, project) {
        const refs = Array.isArray(task?.projectRefs) ? task.projectRefs : [];
        if (project?.title === UNASSIGNED_PROJECT || project?.key === 'unassigned') return refs.length === 0;
        if (project?.key) return refs.some((ref) => ref.key === project.key);
        return refs.some((ref) => ref.title === project?.title);
    }
    normalizeProject(project, index) {
        const notePath = normalisePath(project.notePath || project.path || '');
        const title = String(project.title || project.name || UNASSIGNED_PROJECT).trim() || UNASSIGNED_PROJECT;
        return {
            id: project.id || uid('project'),
            key: project.key || (title === UNASSIGNED_PROJECT ? 'unassigned' : (notePath ? `file:${notePath}` : `raw:${title.toLocaleLowerCase('zh-Hans-CN')}`)),
            title,
            color: project.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
            notes: project.notes || '',
            notePath,
            rawValue: project.rawValue || '',
            explicit: project.explicit === true,
            sourceType: project.sourceType || (notePath ? 'note' : 'value'),
            projectTask: project.projectTask || null,
            tasks: []
        };
    }
    projectOrderKey(project) {
        return String(project?.key || project?.id || project?.title || '').trim();
    }
    projectAllTasks(project) {
        return Array.isArray(project?.allTasks) ? project.allTasks : (project?.tasks || []);
    }
    projectReadyToComplete(project) {
        const tasks = this.projectAllTasks(project);
        return tasks.length > 0 && tasks.every((task) => task.done);
    }
    projectCompleted(project) {
        const file = this.projectNoteFileForDelete(project);
        if (!(file instanceof TFile)) return false;
        const fm = this.getLinkedFrontmatter(file) || {};
        const field = this.taskNotesFields().status;
        const taskNotes = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const isTask = this.isTaskNotesTaskFile(file, fm);
        const status = String(fm[field] || (isTask ? taskNotes?.settings?.defaultTaskStatus : '') || '').trim();
        let statusCompleted = this.isCompletedStatusValue(status);
        try {
            const managed = taskNotes?.statusManager?.isCompletedStatus?.(status);
            if (typeof managed === 'boolean') statusCompleted = managed;
        } catch {}
        // Preserve legacy completion display, but ordinary notes own their
        // project lifecycle separately from unrelated status properties.
        const complete = isTask ? statusCompleted : ('project_status' in fm
            ? ['completed', 'done', '已完成'].includes(String(fm.project_status || '').toLowerCase())
            : statusCompleted);
        const key = this.projectOrderKey(project);
        const pending = this.completedOverrides?.get(key);
        if (pending && pending.value !== complete && pending.until > Date.now()) return pending.value;
        this.completedOverrides?.delete(key);
        return !!complete;
    }
    projectGroup(project) {
        return this.projectArchived(project) ? 'archived' : this.projectCompleted(project) ? 'completed' : 'active';
    }
    projectPinned(project) {
        return this.plugin.settings.projectViewState?.[this.projectOrderKey(project)]?.pinned === true;
    }
    projectCollapsed(project) {
        const state = this.plugin.settings.projectViewState?.[this.projectOrderKey(project)];
        return typeof state?.collapsed === 'boolean' ? state.collapsed : this.projectCompleted(project);
    }
    async refreshProjectViews() {
        this.shouldScrollToday = false;
        await this.render();
        const views = new Set([...(this.plugin.ganttViews || []), ...this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => leaf.view)]);
        for (const view of views) if (view !== this && view.contentEl?.isConnected) await view.render();
    }
    async setProjectViewState(project, patch) {
        const key = this.projectOrderKey(project);
        const previous = this.plugin.settings.projectViewState || {};
        const state = { ...previous[key] };
        for (const field of ['pinned', 'collapsed']) if (typeof patch[field] === 'boolean') state[field] = patch[field];
        this.plugin.settings.projectViewState = { ...previous, [key]: state };
        try { await this.plugin.saveSettings(); }
        catch (error) { this.plugin.settings.projectViewState = previous; new Notice(`项目显示设置保存失败：${error.message}`); return false; }
        await this.refreshProjectViews();
        return true;
    }
    async migrateProjectViewState(file, oldPath) {
        const previous = {
            projectViewState: this.plugin.settings.projectViewState,
            taskOrder: this.plugin.settings.taskOrder,
            projects: this.plugin.settings.projects
        };
        const states = { ...(previous.projectViewState || {}) };
        const orders = Object.fromEntries(Object.entries(previous.taskOrder || {}).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
        const projects = (previous.projects || []).map((project) => ({ ...project }));
        const oldKey = `file:${oldPath}`, newKey = `file:${file.path}`;
        let changed = false;
        if (states[oldKey]) {
            states[newKey] = { ...states[newKey], ...states[oldKey] };
            delete states[oldKey];
            changed = true;
        }
        if (Array.isArray(orders[oldKey])) {
            orders[newKey] = [...new Set([...orders[oldKey], ...(Array.isArray(orders[newKey]) ? orders[newKey] : [])])];
            delete orders[oldKey];
            changed = true;
        }
        for (const [key, order] of Object.entries(orders)) {
            if (Array.isArray(order) && order.includes(`tasknotes:${oldPath}`)) {
                orders[key] = [...new Set(order.map((id) => id === `tasknotes:${oldPath}` ? `tasknotes:${file.path}` : id))];
                changed = true;
            }
        }
        for (const project of projects) {
            if (project.notePath === oldPath || project.key === oldKey) {
                project.notePath = file.path; project.key = newKey;
                project.rawValue = this.app.fileManager.generateMarkdownLink(file, '');
                project.title = this.projectTitleForFile(file);
                changed = true;
            }
        }
        if (!changed) return;
        const next = { projectViewState: states, taskOrder: orders, projects };
        Object.assign(this.plugin.settings, next);
        try { await this.plugin.saveSettings(); }
        catch (error) {
            for (const key of Object.keys(next)) if (this.plugin.settings[key] === next[key]) this.plugin.settings[key] = previous[key];
            new Notice(`改名后的显示顺序保存失败：${error.message}`);
            throw error;
        }
    }
    projectSortMode() {
        const mode = this.plugin.settings.projectSortMode;
        return GANTT_PROJECT_SORT_MODES.has(mode) ? mode : 'urgent';
    }
    projectSortLabel(mode = this.projectSortMode()) {
        return ({ manual: '手动', urgent: '临期优先', due: '截止日期', start: '开始日期', created: '最近创建', name: '名称' })[mode];
    }
    projectSortData(project) {
        const file = this.projectNoteFileForDelete(project);
        const fm = file ? this.getLinkedFrontmatter(file) || {} : {};
        const fields = this.taskNotesFields();
        const tasks = this.projectAllTasks(project);
        const due = dateOnly(fm[fields.due]) || tasks.map((t) => dateOnly(t.due || t.dueDate)).filter(Boolean).sort().pop() || '';
        const nextDue = [dateOnly(fm[fields.due]), ...tasks.filter((t) => !t.done).map((t) => dateOnly(t.due || t.dueDate))].filter(Boolean).sort()[0] || '';
        const created = new Date(fm[fields.dateCreated] || '').getTime() || Number(file?.stat?.ctime || 0);
        return { due, nextDue, start: dateOnly(fm[fields.scheduled]) || project.start || '', created };
    }
    sortProjects(projects) {
        const mode = this.projectSortMode();
        const rows = projects.map((project, index) => ({ project, index, group: this.projectGroup(project), pinned: this.projectPinned(project), dates: this.projectSortData(project) }));
        const groups = { active: 0, completed: 1, archived: 2 };
        rows.sort((a, b) => {
            const group = groups[a.group] - groups[b.group];
            if (group) return group;
            if (a.group === 'active' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            let compared = 0;
            if (mode === 'urgent') compared = this.compareNullableText(a.dates.nextDue, b.dates.nextDue);
            else if (mode === 'due' || mode === 'start') compared = this.compareNullableText(a.dates[mode], b.dates[mode]);
            else if (mode === 'created') compared = b.dates.created - a.dates.created;
            else if (mode === 'name') compared = a.project.title.localeCompare(b.project.title, 'zh-Hans-CN', { numeric: true });
            return compared || a.index - b.index;
        });
        return rows.map((row) => row.project);
    }
    async setProjectCompleted(project, completed) {
        const file = this.projectNoteFileForDelete(project);
        if (!(file instanceof TFile)) { new Notice('请先为项目创建笔记，再标记完成'); return false; }
        const incomplete = this.projectAllTasks(project).filter((task) => !task.done).length;
        if (completed && incomplete) { new Notice(`还有 ${incomplete} 项关联任务未完成，请完成后再结项`); return false; }
        const fields = this.taskNotesFields();
        const taskNotes = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const statuses = taskNotes?.settings?.customStatuses || [];
        const isCompleted = (status) => {
            try {
                const managed = taskNotes?.statusManager?.isCompletedStatus?.(status);
                if (typeof managed === 'boolean') return managed;
            } catch {}
            return statuses.length ? statuses.some((item) => item.value === status && item.isCompleted) : this.isCompletedStatusValue(status);
        };
        const choices = statuses.length ? statuses.map((item) => item.value).filter(Boolean) : [this.tnCompleted, this.tnOpen];
        const targetStatus = choices.find((status) => status === (completed ? this.tnCompleted : this.tnOpen) && isCompleted(status) === completed)
            || choices.find((status) => isCompleted(status) === completed);
        if (this.isTaskNotesTaskFile(file, this.getLinkedFrontmatter(file) || {}) && !targetStatus) {
            new Notice(`TaskNotes 未配置${completed ? '完成' : '未完成'}状态，请先在 TaskNotes 设置中添加`);
            return false;
        }
        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (this.isTaskNotesTaskFile(file, fm)) {
                    if (!targetStatus) throw new Error('TaskNotes 中没有可用的目标状态');
                    fm[fields.status] = targetStatus;
                    if (completed) fm[fields.completedDate] = toYmd(new Date());
                    else delete fm[fields.completedDate];
                } else {
                    fm.project_status = completed ? 'completed' : 'active';
                    if (completed) fm.project_completed_date = toYmd(new Date());
                    else delete fm.project_completed_date;
                }
            });
        } catch (error) { new Notice(`项目状态保存失败：${error.message}`); return false; }
        this.completedOverrides ||= new Map();
        this.completedOverrides.set(this.projectOrderKey(project), { value: completed, until: Date.now() + ARCHIVE_OVERRIDE_MS });
        this.plugin.refreshCarrotHome();
        await this.refreshProjectViews();
        new Notice(completed ? `「${project.title}」已移入已完成区，可展开查看或归档` : `「${project.title}」已恢复进行中`);
        return true;
    }
    showProjectSortMenu(event) {
        const menu = new Menu();
        for (const mode of ['urgent', 'manual', 'due', 'start', 'created', 'name']) {
            menu.addItem((item) => item.setTitle(this.projectSortLabel(mode)).setChecked(this.projectSortMode() === mode).onClick(async () => {
                const previous = this.plugin.settings.projectSortMode;
                this.plugin.settings.projectSortMode = mode;
                try { await this.plugin.saveSettings(); }
                catch (error) { this.plugin.settings.projectSortMode = previous; new Notice(`项目排序保存失败：${error.message}`); return; }
                await this.withPageScrollPreserved(() => this.refreshProjectViews());
            }));
        }
        menu.addSeparator();
        const scope = this.projectQuery || (this.projectFilter || 'all') !== 'all' ? '筛选出的' : '所有';
        for (const collapsed of [true, false]) menu.addItem((item) => item.setTitle(`${collapsed ? '收起' : '展开'}${scope}进行中项目`).setIcon(collapsed ? 'chevrons-down-up' : 'chevrons-up-down').onClick(() => this.withPageScrollPreserved(() => this.setAllProjectsCollapsed(collapsed))));
        menu.showAtMouseEvent(event);
    }
    async setAllProjectsCollapsed(collapsed) {
        const previous = this.plugin.settings.projectViewState || {};
        const next = { ...previous };
        for (const project of this.filterProjects(this.board?.projects || [])) if (this.projectGroup(project) === 'active') {
            const key = this.projectOrderKey(project);
            next[key] = { ...next[key], collapsed };
        }
        this.plugin.settings.projectViewState = next;
        try { await this.plugin.saveSettings(); }
        catch (error) { this.plugin.settings.projectViewState = previous; new Notice(`折叠设置保存失败：${error.message}`); return; }
        await this.refreshProjectViews();
    }
    showProjectActionsMenu(event, project) {
        const anchor = event.currentTarget;
        const menu = new Menu();
        const archived = this.projectArchived(project), completed = this.projectCompleted(project);
        const action = (title, icon, callback) => menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(() => this.withPageScrollPreserved(callback)));
        if (!archived) {
            action(this.projectCollapsed(project) ? '展开项目' : '收起项目', 'chevrons-up-down', () => this.setProjectViewState(project, { collapsed: !this.projectCollapsed(project) }));
            if (!completed) action(this.projectPinned(project) ? '取消置顶' : '置顶项目', 'pin', () => this.setProjectViewState(project, { pinned: !this.projectPinned(project) }));
            action(completed ? '恢复进行中' : '标记已完成', completed ? 'rotate-ccw' : 'check', () => this.setProjectCompleted(project, !completed));
        }
        action(archived ? '取消归档' : '归档项目', archived ? 'archive-restore' : 'archive', () => this.setProjectArchived(project, !archived));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle('项目设置').setIcon('settings').onClick(() => this.openProjectPopover(project, anchor, event)));
        menu.showAtMouseEvent(event);
    }
    normalizeProjectQuery(value) {
        return String(value || '').normalize('NFKC').toLowerCase().trim();
    }
    projectOverdue(project) {
        if (this.projectGroup(project) !== 'active') return false;
        const nextDue = this.projectSortData(project).nextDue;
        return !!nextDue && nextDue < toYmd(new Date());
    }
    filterProjects(projects, filter = this.projectFilter || 'all', query = this.projectQuery || '') {
        const words = this.normalizeProjectQuery(query).split(/\s+/).filter(Boolean);
        return projects.filter((project) => {
            const group = this.projectGroup(project);
            if (['active', 'completed', 'archived'].includes(filter) && group !== filter) return false;
            if (filter === 'overdue' && !this.projectOverdue(project)) return false;
            if (filter === 'ready' && (group !== 'active' || !this.projectReadyToComplete(project))) return false;
            if (!words.length) return true;
            const text = this.normalizeProjectQuery([project.title, project.notePath, ...this.projectAllTasks(project).map((task) => task.title)].join(' '));
            return words.every((word) => text.includes(word));
        });
    }
    isProjectGroupExpanded(group) {
        const searching = !!this.normalizeProjectQuery(this.projectQuery);
        const focused = (this.projectFilter || 'all') === group;
        if ((searching || focused) && typeof this.projectGroupExpansion?.[group] === 'boolean') return this.projectGroupExpansion[group];
        if (searching || focused) return true;
        return this.plugin.settings[group === 'completed' ? 'completedProjectsExpanded' : 'archivedProjectsExpanded'] === true;
    }
    async setProjectFilter(filter) {
        this.projectFilter = ['all', 'active', 'overdue', 'ready', 'completed', 'archived'].includes(filter) ? filter : 'all';
        this.projectGroupExpansion = {};
        this.timelineExtraPast = 0;
        this.timelineExtraFuture = 0;
        await this.withPageScrollPreserved(() => this.render({ reuseBoard: true }));
    }
    async clearProjectFilters() {
        this.projectQuery = '';
        await this.setProjectFilter('all');
    }
    restoreProjectSearchFocus(selection) {
        if (!selection || !this.projectSearchInput?.isConnected) return;
        this.projectSearchInput.focus({ preventScroll: true });
        this.projectSearchInput.setSelectionRange(selection.start, selection.end);
    }
    renderProjectBrowser(root, projects, focusSelection) {
        const browser = el(root, 'div', 'hg-project-browser');
        const searchRow = el(browser, 'div', 'hg-project-search-row');
        const searchLabel = el(searchRow, 'label', 'hg-project-search');
        const icon = el(searchLabel, 'span', 'hg-project-search-icon'); setIcon(icon, 'search');
        const input = el(searchLabel, 'input', 'hg-project-search-input');
        input.type = 'search'; input.placeholder = '搜索项目或关联任务…';
        input.setAttribute('aria-label', '搜索项目名称、路径或关联任务名称');
        input.value = this.projectQuery || '';
        this.projectSearchInput = input;
        const search = (event) => {
            this.projectQuery = input.value;
            this.projectGroupExpansion = {};
            clearTimeout(this.projectSearchTimer);
            if (event.isComposing) return;
            this.projectSearchTimer = setTimeout(() => {
                this.timelineExtraPast = 0; this.timelineExtraFuture = 0;
                this.withPageScrollPreserved(() => this.render({ reuseBoard: true }));
            }, 180);
        };
        input.addEventListener('input', search);
        input.addEventListener('compositionend', search);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.preventDefault(); this.clearProjectFilters(); }
        });
        const matches = this.filterProjects(projects);
        el(searchRow, 'span', 'hg-project-result-count', `${matches.length} / ${projects.length} 个项目`);
        if (this.projectQuery || (this.projectFilter || 'all') !== 'all') {
            const clear = el(searchRow, 'button', 'hg-project-clear', '清除筛选');
            clear.type = 'button'; clear.addEventListener('click', () => this.clearProjectFilters());
        }
        const filters = el(browser, 'div', 'hg-project-filters');
        filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '项目快捷筛选');
        for (const [value, label] of [['all', '全部'], ['active', '进行中'], ['overdue', '逾期'], ['ready', '待结项'], ['completed', '已完成'], ['archived', '已归档']]) {
            const count = this.filterProjects(projects, value).length;
            const button = el(filters, 'button', `hg-project-filter${(this.projectFilter || 'all') === value ? ' is-active' : ''}`, `${label} ${count}`);
            button.type = 'button'; button.dataset.filter = value;
            button.setAttribute('aria-pressed', String((this.projectFilter || 'all') === value));
            button.addEventListener('click', () => this.setProjectFilter(value));
        }
        this.restoreProjectSearchFocus(focusSelection);
    }
    taskSortMode() {
        const mode = String(this.plugin.settings.taskSortMode || 'smart');
        return GANTT_TASK_SORT_MODES.has(mode) ? mode : 'smart';
    }
    taskSortLabel(mode = this.taskSortMode()) {
        return ({
            smart: '智能',
            manual: '手动',
            start: '开始日期',
            due: '截止日期',
            priority: '优先级'
        })[mode] || '智能';
    }
    compareNullableText(left, right) {
        const a = String(left || '').trim();
        const b = String(right || '').trim();
        if (a && b) return a < b ? -1 : a > b ? 1 : 0;
        return a ? -1 : b ? 1 : 0;
    }
    taskManualRanks(project) {
        const order = this.plugin.settings.taskOrder?.[this.projectOrderKey(project)];
        return new Map((Array.isArray(order) ? order : []).map((id, index) => [String(id), index]));
    }
    sortProjectTasks(project) {
        const tasks = Array.isArray(project?.tasks) ? project.tasks : [];
        if (tasks.length < 2) return tasks;
        const mode = this.taskSortMode();
        const sourceIndex = new Map(tasks.map((task, index) => [String(task.id), index]));
        const manualRanks = this.taskManualRanks(project);
        const manualCompare = (a, b) => {
            const ar = manualRanks.has(String(a.id)) ? manualRanks.get(String(a.id)) : Number.MAX_SAFE_INTEGER;
            const br = manualRanks.has(String(b.id)) ? manualRanks.get(String(b.id)) : Number.MAX_SAFE_INTEGER;
            return ar - br || sourceIndex.get(String(a.id)) - sourceIndex.get(String(b.id));
        };
        if (mode === 'manual') {
            tasks.sort(manualCompare);
            return tasks;
        }
        const startDate = (task) => dateOnly(task?.scheduled) || dateOnly(task?.start) || '';
        const dueDate = (task) => dateOnly(task?.due) || dateOnly(task?.dueDate) || dateOnly(task?.end) || '';
        tasks.sort((a, b) => {
            if (mode === 'smart' && a.workflowOrder > 0 && b.workflowOrder > 0 && a.workflowOrder !== b.workflowOrder) return a.workflowOrder - b.workflowOrder;
            if (!!a.done !== !!b.done) return a.done ? 1 : -1;
            const priority = this.taskPriorityRank(a.priority) - this.taskPriorityRank(b.priority);
            const start = this.compareNullableText(startDate(a), startDate(b));
            const due = this.compareNullableText(dueDate(a), dueDate(b));
            let compared = 0;
            if (mode === 'priority') compared = priority || start || due;
            else if (mode === 'start') compared = start || due || priority;
            else if (mode === 'due') compared = due || start || priority;
            else compared = priority || start || due;
            return compared || manualCompare(a, b);
        });
        return tasks;
    }
    buildProjects(tasks, mode, projectCandidates = [], allTasks = tasks, discoveryTasks = tasks) {
        const projects = [];
        const storedRecords = this.plugin.settings.projects || [];
        const stored = storedRecords.map((p, i) => this.normalizeProject(p, i));
        const legacyStored = new Set(stored.filter((p, i) => !storedRecords[i].key && !storedRecords[i].notePath && !storedRecords[i].path));
        const storedByKey = new Map(stored.map((p) => [p.key, p]));
        if (mode === 'tasknotes') {
            // Show explicit project tasks/notes even before they have children, while
            // retaining stored UI metadata, TaskNotes defaults, and referenced projects.
            const seen = new Set();
            const candidatesByKey = new Map();
            for (const task of projectCandidates) {
                const ref = this.projectRefFromFile(task?.file);
                if (ref?.key) candidatesByKey.set(ref.key, { ref, task });
            }
            const knownKeysByTitle = new Map();
            const rememberIdentity = (ref) => {
                if (!ref?.key || !String(ref.key).startsWith('file:')) return;
                if (!knownKeysByTitle.has(ref.title)) knownKeysByTitle.set(ref.title, new Set());
                knownKeysByTitle.get(ref.title).add(ref.key);
            };
            for (const candidate of candidatesByKey.values()) rememberIdentity(candidate.ref);
            for (const task of [...tasks, ...discoveryTasks]) for (const ref of task.projectRefs || []) rememberIdentity(ref);
            for (const project of stored) rememberIdentity(project);
            const usedIds = new Set();
            const addProjectRef = (ref, deco = null, candidate = null) => {
                if (!ref?.key || seen.has(ref.key)) return;
                seen.add(ref.key);
                // A title is a label, not identity: two notes may share it.
                deco = deco || storedByKey.get(ref.key) || null;
                candidate = candidate || candidatesByKey.get(ref.key) || null;
                const project = this.normalizeProject({
                    key: ref.key,
                    title: candidate?.task?.title || deco?.title || ref.title,
                    id: deco?.id && !usedIds.has(deco.id) ? deco.id : undefined,
                    color: deco?.color,
                    notes: deco?.notes,
                    notePath: ref.notePath || deco?.notePath || deco?.path || '',
                    rawValue: ref.rawValue || deco?.rawValue || '',
                    explicit: !!candidate,
                    sourceType: candidate ? (candidate.task?.projectNote ? 'note' : (ref.sourceType || 'task')) : (ref.sourceType || 'note'),
                    projectTask: candidate?.task?.projectNote ? null : (candidate?.task || null)
                }, projects.length);
                usedIds.add(project.id);
                projects.push(project);
            };
            for (const p of stored) {
                const notePath = p.notePath || (String(p.key).startsWith('file:') ? String(p.key).slice(5) : '');
                const ambiguousLegacy = legacyStored.has(p) && (knownKeysByTitle.get(p.title)?.size || 0) > 1;
                const ref = ambiguousLegacy ? { key: p.key, title: p.title, rawValue: p.rawValue || p.title, sourceType: 'value' } : notePath
                    ? this.projectRefFromValue(`[[${notePath.replace(/\.md$/i, '')}]]`)
                    : this.projectRefFromValue(p.rawValue || p.title);
                if (ref) addProjectRef(ref, p);
            }
            for (const candidate of candidatesByKey.values()) addProjectRef(candidate.ref, null, candidate);
            for (const value of defaultProjectsList(this.tn?.taskCreationDefaults?.defaultProjects)) {
                const ref = this.projectRefFromValue(value);
                if (ref) addProjectRef(ref);
            }
            const refs = tasks.flatMap((task) => task.projectRefs || [])
                .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
            for (const ref of refs) addProjectRef(ref);
            // A completed project (or one ready to close) remains reachable even
            // when its completed children are hidden by the current task filter.
            // Only inspect relationships present in the configured source scope;
            // full-vault statistics must not discover unrelated projects.
            const sourceRefs = new Map(discoveryTasks.flatMap((task) => task.projectRefs || [])
                .map((ref) => [ref.key, ref]));
            for (const ref of sourceRefs.values()) {
                if (seen.has(ref.key)) continue;
                const candidate = this.normalizeProject(ref, projects.length);
                const linked = allTasks.filter((task) => task.file?.path !== ref.notePath && this.taskBelongsToProject(task, candidate));
                if (this.projectArchived(candidate) || this.projectCompleted?.(candidate) || (linked.length > 0 && linked.every((task) => task.done))) addProjectRef(ref);
            }
        } else {
            const seen = new Set();
            for (const p of stored) {
                if (!seen.has(p.title)) {
                    seen.add(p.title);
                    projects.push(p);
                }
            }
            for (const task of tasks) {
                if (!seen.has(task.project)) {
                    const p = this.normalizeProject({
                        title: task.project
                    }, projects.length);
                    seen.add(p.title);
                    projects.push(p);
                }
            }
        }
        if (!projects.length && mode !== 'tasknotes') projects.push(this.normalizeProject({
            key: 'unassigned',
            title: UNASSIGNED_PROJECT,
            color: DEFAULT_COLORS[0]
        }, 0));
        for (const project of projects) project.allTasks = [];
        const assignTasks = (source, field) => {
            for (const task of source) {
                const memberships = projects.filter((project) => task.file?.path !== project.notePath && this.taskBelongsToProject(task, project));
                const targets = memberships.length ? memberships : projects.filter((project) => project.title === UNASSIGNED_PROJECT).slice(0, 1);
                for (const project of targets) project[field].push(task);
            }
        };
        assignTasks(tasks, 'tasks');
        assignTasks(allTasks, 'allTasks');
        for (const p of projects) {
            this.sortProjectTasks(p);
            this.syncProjectDates(p);
        }
        return projects;
    }

    async loadBoard() {
        const src = await this.getTaskSource();
        this.activeTaskSource = src;
        if (!src || src.mode !== 'tasknotes') return null;
        const board = await this.loadTaskNotesBoard(src.taskConfig);
        if (board) board.source = src;
        return board;
    }

    // ---------- TaskNotes source ----------
    pruneTaskBodyCache(force = false) {
        const cache = this._taskBodyCache;
        if (!cache) return;
        const now = Date.now();
        if (force || this._taskBodyCachePrunedAt == null || now - this._taskBodyCachePrunedAt >= 30000) {
            this._taskBodyCachePrunedAt = now;
            const lookup = this.app.vault.getAbstractFileByPath;
            if (typeof lookup === 'function') {
                for (const [path, entry] of cache) {
                    const file = lookup.call(this.app.vault, path);
                    if (!file || file.path !== path || file.stat?.mtime !== entry.mtime || file.stat?.size !== entry.size) {
                        cache.delete(path);
                        this._taskBodyCacheChars -= entry.body.length;
                    }
                }
            }
        }
        // Bound retained text as well as entry count; a single large note must
        // not turn repeated UI renders into an unbounded in-memory vault copy.
        while (cache.size > 2048 || this._taskBodyCacheChars > 4000000) {
            const oldest = cache.keys().next().value;
            const entry = cache.get(oldest);
            if (!entry) break;
            cache.delete(oldest);
            this._taskBodyCacheChars -= entry.body.length;
        }
    }
    async readTaskBodyCached(file, repository = null, retry = 0) {
        const read = () => repository?.readText ? repository.readText(file) : this.app.vault.cachedRead(file);
        const path = String(file?.path || '');
        const mtime = file?.stat?.mtime;
        const size = file?.stat?.size;
        // Without both revision signals a cache hit cannot establish freshness.
        if (!path || !Number.isFinite(mtime) || !Number.isFinite(size) || size < 0) return bodyWithoutFrontmatter(await read());
        if (!this._taskBodyCache) {
            this._taskBodyCache = new Map();
            this._taskBodyCacheChars = 0;
            this._taskBodyCachePrunedAt = null;
        }
        if (!this._taskBodyReads) this._taskBodyReads = new Map();
        const cache = this._taskBodyCache;
        const reads = this._taskBodyReads;
        this.pruneTaskBodyCache();
        const cached = cache.get(path);
        if (cached) {
            cache.delete(path);
            if (cached.mtime === mtime && cached.size === size) {
                cache.set(path, cached); // Refresh LRU position without rereading.
                return cached.body;
            }
            this._taskBodyCacheChars -= cached.body.length;
        }
        const key = `${path}\u0000${mtime}\u0000${size}`;
        if (reads.has(key)) return reads.get(key);
        const pending = (async () => {
            const body = bodyWithoutFrontmatter(await read());
            // Closing a view clears/replaces these maps. A late read may finish,
            // but it must neither repopulate a closed view nor overwrite a newer read.
            if (this._taskBodyCache !== cache || this._taskBodyReads !== reads || reads.get(key) !== pending) return body;
            const lookup = this.app.vault.getAbstractFileByPath;
            const current = typeof lookup === 'function' ? lookup.call(this.app.vault, path) : file;
            if (!current || current.path !== path) return body;
            if (current.stat?.mtime !== mtime || current.stat?.size !== size) {
                // Re-read once if editing overlapped the read. Continuous edits
                // stay uncached and will be picked up by the next normal refresh.
                return retry < 1 ? this.readTaskBodyCached(current, repository, retry + 1) : body;
            }
            if (body.length <= 128 * 1024) {
                const previous = cache.get(path);
                if (previous) this._taskBodyCacheChars -= previous.body.length;
                cache.delete(path);
                cache.set(path, { mtime, size, body });
                this._taskBodyCacheChars += body.length;
                this.pruneTaskBodyCache();
            }
            return body;
        })();
        reads.set(key, pending);
        try {
            return await pending;
        } finally {
            // Rejections are never cached, and a later successful read can retry.
            if (reads.get(key) === pending) reads.delete(key);
        }
    }
    async loadTaskNotesBoard(taskConfig = null) {
        const tn = await this.getTaskNotesSettings();
        this.tn = tn;
        this.tnCompleted = this.taskNotesCompletedStatus(tn);
        this.tnOpen = this.taskNotesOpenStatus(tn);
        const configuredStatuses = Array.isArray(tn?.customStatuses) ? tn.customStatuses : [];
        const completedValues = configuredStatuses
            .filter((s) => s.isCompleted)
            .map((s) => String(s.value || '').trim().toLowerCase())
            .filter(Boolean);
        this.tnStatusesCompleted = new Set(configuredStatuses.length ? completedValues : ['done']);
        const carrotHome = await this.getCarrotHomeSettings();
        const fields = this.taskNotesFields(tn, carrotHome);
        const statusKey = fields.status;
        const projField = fields.projects;

        const statusColors = new Map();
        (Array.isArray(tn?.customStatuses) ? tn.customStatuses : []).forEach((s) => {
            if (s?.color) statusColors.set(String(s.value).trim().toLowerCase(), s.color);
        });

        const tasks = [];
        const repository = this.getTaskRepository();
        const taskNotesPlugin = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const taskNotesCache = taskNotesPlugin?.cacheManager;
        const repositoryEntries = new Map(Array.from(repository?.entries?.() || [])
            .filter((entry) => entry?.file?.path).map((entry) => [entry.file.path, entry]));
        // Repository snapshots may only cover a dashboard's folder scope. Read
        // every live task so that a visible project's totals include all children.
        const entries = this.app.vault.getMarkdownFiles().map((file) => ({
            file,
            frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter || repositoryEntries.get(file.path)?.frontmatter || null
        }));
        for (const entry of entries) {
            const file = entry.file;
            // TaskNotes is authoritative for task identity and display title.
            // Prefer Obsidian's current metadata and TaskNotes' runtime task over
            // a possibly stale dashboard repository snapshot.
            const fm = this.getLinkedFrontmatter(file) || entry.frontmatter;
            if (!this.isTaskNotesTaskFile(file, fm)) continue;
            const taskInfo = taskNotesCache?.getCachedTaskInfoSync?.(file.path) || null;
            const status = String(fm[statusKey] ?? '').trim()
                || String(taskInfo?.status || tn?.defaultTaskStatus || this.tnOpen || 'open').trim();
            const pendingDates = this.pendingTaskDateOverrides.get(file.path);
            if (pendingDates?.expiresAt && pendingDates.expiresAt < Date.now()) this.pendingTaskDateOverrides.delete(file.path);
            const activeDates = pendingDates?.expiresAt >= Date.now() ? pendingDates : null;
            const scheduled = activeDates?.scheduled ?? fmString(fm, [fields.scheduled]);
            const due = activeDates?.due ?? fmString(fm, [fields.due]);
            const estimateRaw = activeDates?.timeEstimate ?? fm[fields.timeEstimate];
            const timeline = taskNotesTimeline(scheduled, due, estimateRaw);
            // TaskNotes owns completion semantics. Dashboard completion filters
            // select rows; they must not redefine whether a task is completed.
            let done = this.isCompletedStatusValue(status);
            try {
                const managed = taskNotesPlugin?.statusManager?.isCompletedStatus?.(status);
                if (typeof managed === 'boolean') done = managed;
            } catch {}
            const rawProjects = Array.isArray(fm[projField]) ? fm[projField].map(String) : (fm[projField] != null ? [String(fm[projField])] : []);
            const projectRefs = rawProjects.map((value) => this.projectRefFromValue(value, file)).filter(Boolean);
            let content = '';
            try {
                content = await this.readTaskBodyCached(file, repository);
            } catch {}
            tasks.push({
                id: `tasknotes:${file.path}`,
                file,
                linkedFile: file,
                line: -1,
                endLine: -1,
                status,
                statusLine: -1,
                rawLine: '',
                rawBody: '',
                checkbox: done ? 'x' : ' ',
                done,
                title: this.taskNotesTitleForFile(file, fm, taskInfo),
                linkTarget: file.path.replace(/\.md$/i, ''),
                blockId: '',
                rawProjects,
                projectRefs,
                projectKeys: projectRefs.map((ref) => ref.key),
                projectTitles: projectRefs.map((ref) => ref.title),
                project: projectRefs[0]?.title || UNASSIGNED_PROJECT,
                scheduled: timeline.scheduled,
                due: timeline.due,
                scheduledDate: timeline.scheduledDate,
                dueDate: timeline.dueDate,
                timeEstimate: timeline.timeEstimate,
                timelineMode: timeline.timelineMode,
                workflowStage: String(fm.workflow_stage || ''),
                workflowOrder: Number(fm.workflow_order) || 0,
                start: timeline.start,
                end: timeline.end,
                progress: done ? 100 : 0,
                color: DEFAULT_COLORS[0],
                notes: content,
                isProject: this.isProjectMarkerValue(fm[PROJECT_MARKER_FIELD]),
                linkedStatus: status,
                priority: typeof fm[fields.priority] === 'string' ? fm[fields.priority] : ''
                ,created: Number(file.stat?.ctime || 0)
            });
        }

        // Dashboard mode is the exact task membership shown by that Tasks card:
        // folder scope always applies; List additionally applies completion,
        // filter, sorting and count; Kanban keeps all visible columns and omits
        // columns the user hid. "TaskNotes 全部任务" intentionally skips this.
        const scopedTasks = tasks.filter((task) => this.taskPathMatchesSource(task.file.path, taskConfig));
        const sourceTasks = taskConfig ? this.applyDashboardTaskConfig(scopedTasks, taskConfig) : scopedTasks;
        const visibleTasks = this.plugin.settings.showCompletedTasks === false
            ? sourceTasks.filter((task) => !task.done)
            : sourceTasks;

        // Carrot Gantt is a project timeline. TaskNotes tasks without any
        // project-note relationship remain available in TaskNotes/Carrot Home,
        // but they do not belong on this chart and must not affect its range.
        const projectTasks = visibleTasks.filter((task) => Array.isArray(task.projectRefs) && task.projectRefs.length > 0);

        // Build a status list (replaces kanban columns) for the popover selects.
        const columns = [];
        const statusSeen = new Set();
        (Array.isArray(tn?.customStatuses) ? tn.customStatuses : []).slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .forEach((s) => {
                const value = String(s.value || '').trim();
                if (!value || statusSeen.has(value.toLowerCase())) return;
                statusSeen.add(value.toLowerCase());
                columns.push({
                    heading: value,
                    headingLine: -1,
                    endLine: -1,
                    color: s.color || DEFAULT_COLORS[columns.length % DEFAULT_COLORS.length],
                    tasks: []
                });
            });
        for (const task of projectTasks) {
            if (statusSeen.has(task.status.toLowerCase())) continue;
            statusSeen.add(task.status.toLowerCase());
            columns.push({
                heading: task.status,
                headingLine: -1,
                endLine: -1,
                color: statusColors.get(task.status.toLowerCase()) || DEFAULT_COLORS[columns.length % DEFAULT_COLORS.length],
                tasks: []
            });
        }
        if (!columns.length) columns.push({
            heading: 'open',
            headingLine: -1,
            endLine: -1,
            color: DEFAULT_COLORS[0],
            tasks: []
        });

        const projectCandidates = scopedTasks.filter((task) => task.isProject === true);
        const candidatePaths = new Set(projectCandidates.map((task) => task.file?.path).filter(Boolean));
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (candidatePaths.has(file.path)) continue;
            const fm = this.getLinkedFrontmatter(file);
            if (!fm || !this.isProjectMarkerValue(fm[PROJECT_MARKER_FIELD])) continue;
            projectCandidates.push({
                id: `project-note:${file.path}`,
                file,
                title: this.projectTitleForFile(file),
                isProject: true,
                projectNote: true
            });
            candidatePaths.add(file.path);
        }
        const projects = this.buildProjects(projectTasks, 'tasknotes', projectCandidates, tasks, scopedTasks);
        return {
            mode: 'tasknotes',
            file: null,
            lines: [],
            columns,
            projects,
            tasks: projectTasks,
            footerStart: 0
        };
    }

    // ---------- Kanban source ----------
    async loadKanbanBoard(file) {
        if (!(file instanceof TFile)) return null;
        const repository = this.getTaskRepository();
        const content = repository?.readText ? await repository.readText(file) : await this.app.vault.cachedRead(file);
        const lines = content.split('\n');
        const {
            columns,
            footerStart
        } = parseColumns(lines);
        const tasks = [];
        columns.forEach((column, colIndex) => {
            column.id = `col-${column.headingLine}-${column.heading}`;
            column.color = DEFAULT_COLORS[colIndex % DEFAULT_COLORS.length];
            for (let line = column.headingLine + 1; line < column.endLine;) {
                const m = TASK_RE.exec(lines[line]);
                if (!m) {
                    line++;
                    continue;
                }
                const rawBody = m[2].trim();
                if (!rawBody) {
                    line++;
                    continue;
                }
                const blockEnd = taskBlockEnd(lines, line);
                const explicitStart = dateOnly(extractMark(rawBody, '🛫') || extractMark(rawBody, '⏳'));
                const explicitEnd = dateOnly(extractMark(rawBody, '📅'));
                const start = explicitStart || explicitEnd || toYmd(new Date());
                const end = explicitEnd || start;
                const done = m[1].toLowerCase() === 'x' || looksDoneColumn(column.heading);
                const linkTarget = linkedPathFromText(rawBody);
                const linkedFile = this.resolveLinkedFileFromTarget(linkTarget);
                const fm = this.getLinkedFrontmatter(linkedFile);
                const columnNames = new Set(columns.map((c) => c.heading));
                const storedProjectNames = new Set((this.plugin.settings.projects || []).map((p) => String(p.title || p.name || '').trim()).filter(Boolean));
                let project = this.getTaskProject(rawBody, linkedFile);
                // Earlier builds accidentally wrote Kanban column names into task frontmatter.project.
                // Treat those as unassigned unless the user explicitly created a same-named Gantt project.
                if (columnNames.has(project) && !storedProjectNames.has(project)) project = UNASSIGNED_PROJECT;
                const task = {
                    id: `${file.path}:${blockIdFromText(rawBody) || line}:${cleanTaskText(rawBody)}`,
                    file,
                    linkedFile,
                    line,
                    endLine: blockEnd,
                    status: column.heading,
                    statusLine: column.headingLine,
                    rawLine: lines[line],
                    rawBody,
                    checkbox: m[1],
                    done,
                    title: displayTitle(rawBody),
                    linkTarget,
                    blockId: blockIdFromText(rawBody),
                    project,
                    start,
                    end: parseDate(end) < parseDate(start) ? start : end,
                    progress: done ? 100 : 0,
                    color: DEFAULT_COLORS[0],
                    notes: descriptionLines(lines, line).join('\n'),
                    linkedStatus: fmString(fm, ['status', '状态'])
                };
                tasks.push(task);
                column.tasks.push(task);
                line = blockEnd;
            }
        });
        const projects = this.buildProjects(tasks, 'kanban');
        return {
            mode: 'kanban',
            file,
            lines,
            columns,
            projects,
            tasks,
            footerStart
        };
    }

    syncProjectDates(project) {
        const tasks = Array.isArray(project.allTasks) ? project.allTasks : (project.tasks || []);
        const dates = tasks.flatMap(task => [task.start, task.end, task.dueDate]).map(dateOnly).filter(Boolean).sort();
        project.start = dates[0] || '';
        project.end = dates[dates.length - 1] || '';
        project.taskCount = tasks.length;
        project.completedCount = tasks.filter((task) => task.done).length;
        project.progress = tasks.length ? Math.round(project.completedCount * 100 / tasks.length) : 0;
    }
    computeRange() {
        const today = startOfDay(new Date());
        // Keep the everyday view focused. The old -45/+180 default rendered
        // more than seven empty months even when every task was near today,
        // making horizontal navigation feel like searching rather than planning.
        // Outlying tasks still expand the range, so no dated work is hidden.
        const pastDays = clamp(Math.round(Number(this.plugin.settings.rangePastDays ?? RANGE_PAST_DAYS)), 0, 180);
        const futureDays = clamp(Math.round(Number(this.plugin.settings.rangeFutureDays ?? RANGE_FUTURE_DAYS)), 14, 365);
        let min = addDays(today, -pastDays),
            max = addDays(today, futureDays);
        const includeDate = (value) => {
            const normalized = dateOnly(value);
            if (!normalized) return;
            const date = parseDate(normalized);
            if (date < min) min = date;
            if (date > max) max = date;
        };
        for (const p of this.filterProjects(this.board?.projects || [])) {
            if (this.projectArchived(p)) continue;
            if (this.projectCompleted?.(p) && !this.isProjectGroupExpanded('completed')) continue;
            // Project dates use all related tasks and remain stable under filters.
            includeDate(p.start);
            includeDate(p.end);
            for (const task of p.tasks || []) {
                includeDate(task.start);
                includeDate(task.end);
                includeDate(task.dueDate);
            }
        }
        min = addDays(min, -3);
        max = addDays(max, 10);
        let days = diffDays(min, max) + 1;
        if (days < MIN_RANGE_DAYS) {
            max = addDays(min, MIN_RANGE_DAYS - 1);
            days = MIN_RANGE_DAYS;
        }
        min = addDays(min, -Math.max(0, Number(this.timelineExtraPast || 0)));
        max = addDays(max, Math.max(0, Number(this.timelineExtraFuture || 0)));
        days = diffDays(min, max) + 1;
        return {
            start: min,
            end: max,
            days
        };
    }

    capturePageScroll() {
        const items = [];
        const add = (el, selector = '') => {
            if (!el || items.some((it) => it.el === el)) return;
            items.push({ el, selector, top: el.scrollTop, left: el.scrollLeft });
        };
        add(document.scrollingElement || document.documentElement, 'document');
        add(document.querySelector('.hearth-scroll'), '.hearth-scroll');
        add(document.querySelector('.workspace-leaf.mod-active .view-content'), '.workspace-leaf.mod-active .view-content');
        add(this.rootEl?.closest?.('.view-content'), this.homeViewContentSelector());
        add(this.rootEl?.closest?.('.hearth-view'), '.hearth-view');
        let el = this.rootEl?.parentElement;
        while (el && el !== document.body) {
            const cs = window.getComputedStyle(el);
            if (/(auto|scroll)/.test(`${cs.overflow}${cs.overflowY}${cs.overflowX}`)) {
                add(el, el.classList?.contains('hearth-scroll') ? '.hearth-scroll' : '');
            }
            el = el.parentElement;
        }
        return items;
    }
    restorePageScroll(snapshot) {
        const restore = () => {
            for (const item of snapshot || []) {
                let el = item.el?.isConnected ? item.el : null;
                if (!el && item.selector && item.selector !== 'document') el = document.querySelector(item.selector);
                if (!el && item.selector === 'document') el = document.scrollingElement || document.documentElement;
                if (!el) continue;
                el.scrollTop = item.top;
                el.scrollLeft = item.left;
            }
        };
        restore();
        window.requestAnimationFrame(() => {
            restore();
            window.requestAnimationFrame(restore);
        });
        window.setTimeout(restore, 80);
        window.setTimeout(restore, 220);
    }
    async withPageScrollPreserved(action) {
        const snapshot = this.capturePageScroll();
        try {
            return await action();
        } finally {
            this.restorePageScroll(snapshot);
        }
    }

    dataSourceLabel() {
        const mode = this.plugin.settings.dataSource || 'dashboard';
        return mode === 'tasknotes' ? '数据源：TaskNotes' : '数据源：当前主页';
    }

    showDataSourceMenu(event) {
        const current = this.plugin.settings.dataSource || 'dashboard';
        const menu = new Menu();
        const choose = async (mode) => {
            if (mode === current) return;
            this.plugin.settings.dataSource = mode;
            await this.plugin.saveSettings();
            this.shouldScrollToday = false;
            await this.render();
        };
        menu.addItem((item) => item.setTitle('当前 Dashboard 的 Tasks 卡片').setIcon('layout-dashboard').setChecked(current === 'dashboard').onClick(() => choose('dashboard')));
        menu.addItem((item) => item.setTitle('TaskNotes 全部任务').setIcon('list-todo').setChecked(current === 'tasknotes').setDisabled(!this.isTaskNotesEnabled()).onClick(() => choose('tasknotes')));
        menu.showAtMouseEvent(event);
    }

    showTaskSortMenu(event) {
        const current = this.taskSortMode();
        const menu = new Menu();
        const choose = async (mode) => {
            if (mode === current) return;
            this.plugin.settings.taskSortMode = mode;
            await this.plugin.saveSettings();
            this.shouldScrollToday = false;
            await this.withPageScrollPreserved(() => this.render());
        };
        [
            ['smart', '智能排序', 'sparkles'],
            ['manual', '手动排序', 'grip-vertical'],
            ['start', '开始日期', 'calendar-arrow-up'],
            ['due', '截止日期', 'calendar-clock'],
            ['priority', '优先级', 'list-filter']
        ].forEach(([mode, title, icon]) => {
            menu.addItem((item) => item.setTitle(title).setIcon(icon).setChecked(current === mode).onClick(() => choose(mode)));
        });
        menu.showAtMouseEvent(event);
    }

    captureTimelineViewport() {
        const pane = this.timelinePane;
        if (!pane?.isConnected) return null;
        const snapshot = { left: pane.scrollLeft, top: pane.scrollTop };
        const rendered = this.renderedTimelineRange;
        if (rendered?.start && rendered.cellWidth > 0) {
            const position = (pane.scrollLeft + pane.clientWidth / 2) / rendered.cellWidth;
            const wholeDays = Math.floor(position);
            snapshot.anchorDay = toYmd(addDays(rendered.start, wholeDays));
            snapshot.anchorFraction = position - wholeDays;
        }
        return snapshot;
    }
    restoreTimelineViewport(snapshot, range, cellWidth, pane = this.timelinePane) {
        if (!pane?.isConnected || pane !== this.timelinePane) return;
        // Filtering can move the range origin by years. Preserve the calendar
        // date at the viewport center, not its pixel offset from the old origin.
        const anchorDay = dateOnly(snapshot?.anchorDay);
        const fraction = Number.isFinite(snapshot?.anchorFraction) ? snapshot.anchorFraction : 0;
        const target = snapshot && !anchorDay ? snapshot.left
            : (diffDays(range.start, anchorDay ? parseDate(anchorDay) : startOfDay(new Date())) + fraction) * cellWidth - pane.clientWidth / 2;
        const max = Math.max(0, pane.scrollWidth - pane.clientWidth);
        pane.scrollLeft = clamp(Number(target) || 0, 0, max);
        pane.scrollTop = snapshot?.top || 0;
    }
    async render(options = {}) {
        clearTimeout(this.projectSearchTimer);
        const focusSelection = this.projectSearchInput && document.activeElement === this.projectSearchInput
            ? { start: this.projectSearchInput.selectionStart, end: this.projectSearchInput.selectionEnd } : null;
        const reusableBoard = options.reuseBoard === true ? this.board : null;
        const seq = ++this.renderSeq;
        const compactMode = this.isCompactDashboardMode();
        const embeddedInHome = !!(this.contentEl.closest?.('.hearth-card') || this.contentEl.closest?.('.hearth-dashboard'));
        const compactEntryMode = compactMode && embeddedInHome;
        this.compactDashboardMode = compactMode;
        this.closePopover();
        this.clearCompactHomeEntry();
        if (this.headerTopbar?.isConnected) this.headerTopbar.remove();
        this.headerTopbar = null;
        const prevTimelineScroll = this.captureTimelineViewport();
        const restoreFromEmpty = this.timelineWasEmpty === true;
        const rangeRestore = this.pendingTimelineRangeRestore || null;
        this.pendingTimelineRangeRestore = null;
        const zoomAnchor = this.pendingTimelineZoomAnchor || null;
        this.pendingTimelineZoomAnchor = null;
        this.contentEl.empty();
        const root = el(this.contentEl, 'div', 'hearth-gantt-view');
        root.toggleClass('is-mobile-narrow', compactMode);
        root.toggleClass('is-compact-entry', compactEntryMode);
        root.toggleClass('is-task-sort-manual', this.taskSortMode() === 'manual');
        root.toggleClass('hide-weekend-shading', this.plugin.settings.showWeekendShading === false);
        this.rootEl = root;
        root.addEventListener('pointerdown', () => {
            this.lastInteractionScroll = this.capturePageScroll();
        }, true);
        root.addEventListener('click', (evt) => {
            if (Date.now() < Number(this.suppressTimelineClickUntil || 0)) {
                evt.preventDefault();
                evt.stopImmediatePropagation();
                return;
            }
            if (this.lastInteractionScroll) this.restorePageScroll(this.lastInteractionScroll);
        }, true);
        const top = el(root, 'div', `hg-topbar hg-topbar-actions-only${compactEntryMode ? ' hg-compact-entry-toolbar' : ''}`);
        const actions = el(top, 'div', 'hg-actions');
        let boardBtn = null;
        let boardActionLabel = '打开任务源';
        if (compactEntryMode) {
            const openBtn = el(actions, 'button', 'hg-button hg-primary hg-compact-open-btn', '打开');
            openBtn.setAttribute('title', '打开完整项目甘特图');
            openBtn.addEventListener('click', () => this.openGanttInNewTab());
        } else {
            const zoomOutBtn = el(actions, 'button', 'hg-button hg-zoom-btn', '−');
            zoomOutBtn.setAttribute('title', '缩小时间尺度');
            zoomOutBtn.setAttribute('aria-label', '缩小时间尺度');
            const zoomInBtn = el(actions, 'button', 'hg-button hg-zoom-btn', '+');
            zoomInBtn.setAttribute('title', '放大时间尺度');
            zoomInBtn.setAttribute('aria-label', '放大时间尺度');
            const todayBtn = el(actions, 'button', 'hg-button hg-today-btn', '今天');
            todayBtn.setAttribute('title', '回到今天');
            const sourceBtn = el(actions, 'button', 'hg-button hg-source-btn', compactMode ? '数据源' : this.dataSourceLabel());
            sourceBtn.setAttribute('title', this.dataSourceLabel());
            const projectSortBtn = el(actions, 'button', 'hg-button hg-project-sort-btn', compactMode ? '项目排序' : `项目：${this.projectSortLabel()}`);
            projectSortBtn.setAttribute('title', `项目排序：${this.projectSortLabel()}；也可在菜单中全部收起或展开`);
            projectSortBtn.addEventListener('click', (event) => this.showProjectSortMenu(event));
            const sortBtn = el(actions, 'button', 'hg-button hg-sort-btn', compactMode ? '任务排序' : `任务：${this.taskSortLabel()}`);
            sortBtn.setAttribute('title', `任务排序：${this.taskSortLabel()}`);
            zoomOutBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.zoomTimeline(-1)));
            zoomInBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.zoomTimeline(1)));
            todayBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.scrollToToday()));
            sourceBtn.addEventListener('click', (event) => this.showDataSourceMenu(event));
            sortBtn.addEventListener('click', (event) => this.showTaskSortMenu(event));
            if (compactMode && !embeddedInHome) {
                const moreBtn = el(actions, 'button', 'hg-button hg-more-btn', '更多');
                moreBtn.addEventListener('click', (event) => {
                    const menu = new Menu();
                    menu.addItem((item) => item.setTitle(boardActionLabel).setIcon('list-todo').onClick(() => this.openTaskBoard()));
                    menu.addItem((item) => item.setTitle('新建 TaskNotes 项目任务').setIcon('plus').onClick(() => this.openNewProjectTaskModal()));
                    menu.addItem((item) => item.setTitle('选择现有任务或笔记作为项目').setIcon('file-plus-2').onClick(() => this.withPageScrollPreserved(() => this.addProject())));
                    menu.showAtMouseEvent(event);
                });
            } else {
                const openGanttBtn = el(actions, 'button', 'hg-button hg-open-gantt-btn', '打开甘特图');
                openGanttBtn.setAttribute('title', '在新标签页打开完整甘特图');
                boardBtn = el(actions, 'button', 'hg-button hg-board-btn', boardActionLabel);
                const addProjectBtn = el(actions, 'button', 'hg-button hg-primary hg-add-project-btn', '+ 新项目');
                const chooseProjectBtn = el(actions, 'button', 'hg-button hg-choose-project-btn', '选择现有');
                chooseProjectBtn.setAttribute('title', '选择现有任务或笔记作为项目');
                chooseProjectBtn.setAttribute('aria-label', '选择现有任务或笔记作为项目');
                openGanttBtn.addEventListener('click', () => this.openGanttInNewTab());
                boardBtn.addEventListener('click', () => this.openTaskBoard());
                addProjectBtn.addEventListener('click', () => this.openNewProjectTaskModal());
                chooseProjectBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.addProject()));
            }
        }
        this.attachTopbarToCarrotHomeHeader(top);

        const loading = el(root, 'div', 'hg-loading', '正在读取任务……');
        let board;
        try {
            if (options.reuseBoard === true && this._pendingBoardLoad) {
                // A local filter must not supersede a vault refresh with the old
                // board. Share the newest in-flight load, then apply current UI state.
                board = await this._pendingBoardLoad;
            } else if (reusableBoard) {
                board = reusableBoard;
            } else {
                // Full refreshes always start a new read: a later vault change
                // may have arrived after the previous load took its snapshot.
                const pending = this.loadBoard();
                this._pendingBoardLoad = pending;
                try {
                    board = await pending;
                } finally {
                    if (this._pendingBoardLoad === pending) this._pendingBoardLoad = null;
                }
            }
        } catch (err) {
            console.error('Carrot Gantt load error', err);
        }
        if (seq !== this.renderSeq) return;
        loading.remove();
        if (!board) {
            el(root, 'div', 'hg-empty-state', this.activeTaskSource?.reason || (this.isTaskNotesEnabled()
                ? '当前数据源没有可显示的任务。'
                : 'TaskNotes 当前未启用，甘特图没有可用的数据源。'));
            return;
        }
        this.board = board;
        if (board.mode === 'tasknotes') {
            boardActionLabel = '打开任务列表';
        } else {
            boardActionLabel = '打开看板';
        }
        if (boardBtn) boardBtn.textContent = boardActionLabel;
        if (compactEntryMode) {
            const entry = el(root, 'button', 'hg-compact-entry');
            entry.setAttribute('type', 'button');
            entry.setAttribute('aria-label', '打开完整项目甘特图');
            const icon = el(entry, 'span', 'hg-compact-entry-icon');
            setIcon(icon, 'chart-gantt');
            const copy = el(entry, 'span', 'hg-compact-entry-copy');
            el(copy, 'span', 'hg-compact-entry-title', '打开项目甘特图');
            const projectCount = board.projects?.length || 0;
            const taskCount = board.tasks?.length || 0;
            el(copy, 'span', 'hg-compact-entry-desc', `${projectCount} 个项目 · ${taskCount} 个关联任务`);
            entry.addEventListener('click', () => this.openGanttInNewTab());
            // Android's embedded workspace leaf may report a zero-height flex
            // host. Keep the launcher inside its legitimate Obsidian view (the
            // host removes foreign children), and mark the card/body so CSS can
            // give the whole embedded chain one deterministic compact height.
            this.attachCompactEntryToHomeCard(entry);
            return;
        }
        if (board.mode === 'tasknotes' && !board.projects.length) {
            el(root, 'div', 'hg-empty-state', '暂无关联项目笔记的任务。请先在 TaskNotes 任务的 projects 属性中选择项目笔记。');
            return;
        }

        this.renderProjectBrowser(root, board.projects, focusSelection);
        const filteredProjects = this.filterProjects(board.projects);
        if (!filteredProjects.length) {
            this.timelinePane = null; this.labelRows = null;
            this.renderedTimelineRange = null;
            this.timelineWasEmpty = true;
            const empty = el(root, 'div', 'hg-empty-state hg-project-no-results');
            el(empty, 'p', '', '没有匹配的项目');
            const clear = el(empty, 'button', 'hg-button', '清除筛选，查看全部项目');
            clear.addEventListener('click', () => this.clearProjectFilters());
            return;
        }
        const boardEl = el(root, 'div', 'hg-board');
        const labelPane = el(boardEl, 'div', 'hg-label-pane');
        const timelinePane = el(boardEl, 'div', 'hg-timeline-pane');
        this.timelinePane = timelinePane;
        this.bindPinchZoom(timelinePane);
        const range = this.computeRange();
        const cellWidth = this.displayCellWidth();
        this.renderedTimelineRange = { start: range.start, cellWidth };
        this.timelineWasEmpty = false;
        const timelineWidth = range.days * cellWidth;
        const labelHeader = el(labelPane, 'div', 'hg-label-header', '项目 / 添加任务');
        labelHeader.setAttribute('title', '项目、完成进度与任务数量');
        const timelineHeader = el(timelinePane, 'div', 'hg-time-header');
        timelineHeader.style.width = `${timelineWidth}px`;
        timelineHeader.style.setProperty('--cell-width', `${cellWidth}px`);
        const monthRow = el(timelineHeader, 'div', 'hg-month-row');
        const dayRow = el(timelineHeader, 'div', 'hg-day-row');
        const monthSegments = [];
        for (let i = 0; i < range.days; i++) {
            const date = addDays(range.start, i);
            const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
            const previousMonth = monthSegments[monthSegments.length - 1];
            if (!previousMonth || previousMonth.key !== monthKey) monthSegments.push({ key: monthKey, date, days: 1 });
            else previousMonth.days++;
            const day = el(dayRow, 'div', 'hg-day');
            day.style.width = `${cellWidth}px`;
            const dow = date.getDay();
            if (this.plugin.settings.showWeekendShading !== false && (dow === 0 || dow === 6)) day.addClass('is-weekend');
            if (toYmd(date) === toYmd(new Date())) day.addClass('is-today');
            el(day, 'span', 'hg-day-num', String(date.getDate()));
            day.setAttribute('aria-label', `${toYmd(date)}${dow === 0 || dow === 6 ? '，周末' : ''}`);
        }
        for (const segment of monthSegments) {
            const month = el(monthRow, 'div', 'hg-month-segment');
            month.style.width = `${segment.days * cellWidth}px`;
            // A one-day fragment at the range edge is too narrow for a useful
            // label. Keep its space but let the next full month own the heading.
            if (segment.days > 1) el(month, 'span', 'hg-month-label', MONTH_LABELS[segment.date.getMonth()]);
            month.setAttribute('aria-label', `${segment.date.getFullYear()}年${segment.date.getMonth() + 1}月`);
        }
        const labelRows = el(labelPane, 'div', 'hg-label-rows');
        const timeRows = el(timelinePane, 'div', 'hg-time-rows');
        this.labelRows = labelRows;
        timeRows.style.width = `${timelineWidth}px`;
        this.bindVerticalScrollSync(labelRows, timelinePane);
        this.bindInfiniteTimelineScroll(timelinePane, cellWidth);
        const sortedProjects = this.sortProjects(filteredProjects);
        const archivedProjects = sortedProjects.filter((project) => this.projectGroup(project) === 'archived');
        const completedProjects = sortedProjects.filter((project) => this.projectGroup(project) === 'completed');
        for (const project of sortedProjects) {
            if (this.projectGroup(project) !== 'active') continue;
            this.renderProject(project, labelRows, timeRows, range, cellWidth, timelineWidth, { archived: false });
        }
        if (completedProjects.length) this.renderCompletedGroup(completedProjects, labelRows, timeRows, range, cellWidth, timelineWidth);
        if (archivedProjects.length) this.renderArchivedGroup(archivedProjects, labelRows, timeRows, range, cellWidth, timelineWidth);
        labelHeader.style.height = `${timelineHeader.offsetHeight || 48}px`;
        if (rangeRestore && this.timelinePane) {
            const restoreExtendedRange = () => {
                if (!this.timelinePane?.isConnected) return;
                const max = Math.max(0, this.timelinePane.scrollWidth - this.timelinePane.clientWidth);
                this.timelinePane.scrollLeft = clamp(rangeRestore.left, 0, max);
                this.timelinePane.scrollTop = rangeRestore.top;
            };
            restoreExtendedRange();
            window.requestAnimationFrame(restoreExtendedRange);
        } else if (zoomAnchor && this.timelinePane) {
            const restoreZoomCenter = () => {
                if (!this.timelinePane?.isConnected) return;
                const viewportX = Number.isFinite(zoomAnchor.viewportX)
                    ? zoomAnchor.viewportX
                    : this.timelinePane.clientWidth / 2;
                const target = zoomAnchor.dayPosition * cellWidth - viewportX;
                const max = Math.max(0, this.timelinePane.scrollWidth - this.timelinePane.clientWidth);
                this.timelinePane.scrollLeft = clamp(target, 0, max);
                this.timelinePane.scrollTop = zoomAnchor.top;
            };
            restoreZoomCenter();
            window.requestAnimationFrame(restoreZoomCenter);
        } else if ((prevTimelineScroll || restoreFromEmpty) && this.timelinePane) {
            const pane = this.timelinePane;
            const restoreViewport = () => this.restoreTimelineViewport(prevTimelineScroll, range, cellWidth, pane);
            restoreViewport();
            window.requestAnimationFrame(restoreViewport);
        }
        if (this.shouldScrollToday) {
            window.setTimeout(() => this.scrollToToday(), 80);
            this.shouldScrollToday = false;
        }
    }
    displayCellWidth(value = Number(this.plugin.settings.cellWidth || 34)) {
        const configured = clamp(Number(value) || 34, MIN_CELL_WIDTH, MAX_CELL_WIDTH);
        return this.compactDashboardMode
            ? clamp(Math.round(configured * COMPACT_CELL_SCALE), COMPACT_MIN_CELL_WIDTH, COMPACT_MAX_CELL_WIDTH)
            : configured;
    }

    configuredCellWidthForDisplay(displayWidth) {
        const desired = Number(displayWidth) || this.displayCellWidth();
        if (!this.compactDashboardMode) return clamp(Math.round(desired), MIN_CELL_WIDTH, MAX_CELL_WIDTH);
        const compactDisplay = clamp(desired, COMPACT_MIN_CELL_WIDTH, COMPACT_MAX_CELL_WIDTH);
        return clamp(Math.round(compactDisplay / COMPACT_CELL_SCALE), MIN_CELL_WIDTH, MAX_CELL_WIDTH);
    }
    projectHeight(project, options = {}) {
        // 归档行是收纳行：固定 64px 两行——第一行名称+徽标+计数，第二行日期/进度+取消归档键。
        if (options.archived === true || this.projectArchived(project) || this.projectCollapsed(project)) return 72;
        const bars = project.tasks.length ? (project.tasks.length - 1) * 42 + 30 : 0;
        // 日期与进度并排后摘要从四行减为三行。112px 曾在大字号下裁掉元数据；
        // 三行的 104px 保留同样的字号余量。
        return Math.max(104, bars + 20);
    }
    serializeProject(project) {
        return {
            id: project.id,
            key: project.key,
            title: project.title,
            color: project.color,
            notes: project.notes || '',
            notePath: project.notePath || '',
            rawValue: project.rawValue || ''
        };
    }
    async persistProjectOrder(projects) {
        const visibleKeys = new Set(projects.map((project) => this.projectOrderKey(project)));
        const visibleTitles = new Map();
        for (const project of projects) {
            const title = String(project.title || '').trim().toLocaleLowerCase('zh-Hans-CN');
            visibleTitles.set(title, (visibleTitles.get(title) || 0) + 1);
        }
        const hidden = (this.plugin.settings.projects || []).filter((project) => {
            const normalized = this.normalizeProject(project, 0);
            const title = String(normalized.title || '').trim().toLocaleLowerCase('zh-Hans-CN');
            if (visibleKeys.has(this.projectOrderKey(normalized))) return false;
            const legacy = !project.key && !project.notePath && !project.path;
            return !(legacy && visibleTitles.get(title) === 1);
        });
        this.plugin.settings.projects = [...projects.map((project) => this.serializeProject(project)), ...hidden];
        await this.plugin.saveSettings();
    }
    clearProjectOrderTargets() {
        this.labelRows?.querySelectorAll?.('.is-project-order-before, .is-project-order-after').forEach((node) => {
            node.removeClass('is-project-order-before');
            node.removeClass('is-project-order-after');
        });
    }
    async moveProjectOrder(sourceId, targetId, before = true) {
        const projects = this.board?.projects || [];
        const sourceIndex = projects.findIndex((project) => project.id === sourceId);
        const targetIndex = projects.findIndex((project) => project.id === targetId);
        if (sourceIndex < 0 || targetIndex < 0 || sourceId === targetId) return;
        const visibleIds = new Set(this.filterProjects(projects).map((project) => project.id));
        if (!visibleIds.has(sourceId) || !visibleIds.has(targetId)) return;
        const sourceProject = projects[sourceIndex], targetProject = projects[targetIndex];
        if (this.projectSortMode() !== 'manual' || this.projectGroup(sourceProject) !== this.projectGroup(targetProject)
            || (this.projectGroup(sourceProject) === 'active' && this.projectPinned(sourceProject) !== this.projectPinned(targetProject))) return;
        const [source] = projects.splice(sourceIndex, 1);
        let insertAt = projects.findIndex((project) => project.id === targetId);
        if (!before) insertAt++;
        projects.splice(clamp(insertAt, 0, projects.length), 0, source);
        await this.persistProjectOrder(projects);
        this.shouldScrollToday = false;
        await this.withPageScrollPreserved(() => this.render());
    }
    async moveProjectBy(project, delta) {
        const projects = this.filterProjects(this.board?.projects || []).filter((item) => this.projectGroup(item) === this.projectGroup(project)
            && (this.projectGroup(project) !== 'active' || this.projectPinned(item) === this.projectPinned(project)));
        const index = projects.findIndex((item) => item.id === project.id);
        const next = clamp(index + delta, 0, projects.length - 1);
        if (index < 0 || next === index) return;
        const target = projects[next];
        await this.moveProjectOrder(project.id, target.id, delta < 0);
    }
    bindProjectOrderHandle(handle, rowLabel, project) {
        handle.setAttribute('draggable', 'true');
        handle.setAttribute('role', 'button');
        handle.setAttribute('tabindex', '0');
        handle.setAttribute('aria-label', `调整项目 ${project.title} 的顺序`);
        handle.setAttribute('title', '拖动调整项目顺序；也可用上下方向键');
        handle.addEventListener('pointerdown', (evt) => evt.stopPropagation());
        handle.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
        });
        handle.addEventListener('keydown', (evt) => {
            if (evt.key !== 'ArrowUp' && evt.key !== 'ArrowDown') return;
            evt.preventDefault();
            evt.stopPropagation();
            this.moveProjectBy(project, evt.key === 'ArrowUp' ? -1 : 1);
        });
        handle.addEventListener('dragstart', (evt) => {
            this.projectOrderDragId = project.id;
            rowLabel.addClass('is-project-order-dragging');
            if (evt.dataTransfer) {
                evt.dataTransfer.effectAllowed = 'move';
                evt.dataTransfer.setData('text/plain', project.id);
            }
        });
        handle.addEventListener('dragend', () => {
            this.projectOrderDragId = null;
            rowLabel.removeClass('is-project-order-dragging');
            this.clearProjectOrderTargets();
        });
        rowLabel.addEventListener('dragover', (evt) => {
            if (!this.projectOrderDragId || this.projectOrderDragId === project.id) return;
            evt.preventDefault();
            this.clearProjectOrderTargets();
            const before = evt.clientY < rowLabel.getBoundingClientRect().top + rowLabel.getBoundingClientRect().height / 2;
            rowLabel.addClass(before ? 'is-project-order-before' : 'is-project-order-after');
            if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
        });
        rowLabel.addEventListener('drop', (evt) => {
            if (!this.projectOrderDragId || this.projectOrderDragId === project.id) return;
            evt.preventDefault();
            evt.stopPropagation();
            const sourceId = this.projectOrderDragId;
            const rect = rowLabel.getBoundingClientRect();
            const before = evt.clientY < rect.top + rect.height / 2;
            this.projectOrderDragId = null;
            this.clearProjectOrderTargets();
            this.moveProjectOrder(sourceId, project.id, before);
        });
    }
    async persistTaskOrder(project) {
        this.plugin.settings.taskOrder[this.projectOrderKey(project)] = project.tasks.map((task) => String(task.id));
        await this.plugin.saveSettings();
    }
    clearTaskOrderTargets() {
        this.rootEl?.querySelectorAll?.('.is-task-order-before, .is-task-order-after').forEach((node) => {
            node.removeClass('is-task-order-before');
            node.removeClass('is-task-order-after');
        });
        this.rootEl?.querySelectorAll?.('.hg-task-order-drop-line').forEach((node) => node.removeClass('is-visible'));
    }
    async moveTaskToIndex(project, sourceId, insertAt) {
        const tasks = project.tasks || [];
        const sourceIndex = tasks.findIndex((task) => String(task.id) === String(sourceId));
        if (sourceIndex < 0) return;
        const requestedIndex = clamp(Number(insertAt) || 0, 0, tasks.length);
        const finalIndex = clamp(requestedIndex - (sourceIndex < requestedIndex ? 1 : 0), 0, tasks.length - 1);
        if (finalIndex === sourceIndex) return;
        const [source] = tasks.splice(sourceIndex, 1);
        tasks.splice(finalIndex, 0, source);
        await this.persistTaskOrder(project);
        this.syncProjectDates(project);
        this.shouldScrollToday = false;
        await this.withPageScrollPreserved(() => this.render());
    }
    async moveTaskOrder(project, sourceId, targetId, before = true) {
        const tasks = project.tasks || [];
        const targetIndex = tasks.findIndex((task) => String(task.id) === String(targetId));
        if (targetIndex < 0 || String(sourceId) === String(targetId)) return;
        await this.moveTaskToIndex(project, sourceId, before ? targetIndex : targetIndex + 1);
    }
    async moveTaskBy(project, task, delta) {
        const tasks = project.tasks || [];
        const index = tasks.findIndex((item) => String(item.id) === String(task.id));
        const next = clamp(index + delta, 0, tasks.length - 1);
        if (index < 0 || next === index) return;
        const target = tasks[next];
        await this.moveTaskOrder(project, task.id, target.id, delta < 0);
    }
    bindTaskOrderHandle(handle, bar, project, task, track, topOffset) {
        handle.setAttribute('draggable', 'false');
        handle.setAttribute('role', 'button');
        handle.setAttribute('tabindex', '0');
        handle.setAttribute('aria-label', `调整任务 ${task.title} 的顺序`);
        handle.setAttribute('title', '拖动调整任务顺序；也可用上下方向键');
        handle.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
        });
        handle.addEventListener('keydown', (evt) => {
            if (evt.key !== 'ArrowUp' && evt.key !== 'ArrowDown') return;
            evt.preventDefault();
            evt.stopPropagation();
            this.moveTaskBy(project, task, evt.key === 'ArrowUp' ? -1 : 1);
        });
        handle.addEventListener('pointerdown', (evt) => {
            if (evt.button != null && evt.button !== 0) return;
            handle.focus({ preventScroll: true });
            evt.preventDefault();
            evt.stopPropagation();
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
            const pointerId = evt.pointerId;
            const startX = evt.clientX;
            const startY = evt.clientY;
            let moved = false;
            let insertAt = project.tasks.findIndex((item) => String(item.id) === String(task.id));
            this.taskOrderDrag = { projectId: project.id, taskId: String(task.id), pointerId };
            bar.addClass('is-task-order-dragging');
            try { handle.setPointerCapture(pointerId); } catch {}
            const onMove = (moveEvt) => {
                if (moveEvt.pointerId !== pointerId) return;
                if (Math.hypot(moveEvt.clientX - startX, moveEvt.clientY - startY) > 3) moved = true;
                if (!moved) return;
                moveEvt.preventDefault();
                insertAt = this.taskOrderInsertionAt(track, project, topOffset, moveEvt.clientY);
                this.showTaskOrderInsertion(track, project, topOffset, insertAt);
            };
            let finished = false;
            const cleanup = (cancelled = false) => {
                if (finished) return;
                finished = true;
                try { handle.releasePointerCapture(pointerId); } catch {}
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                window.removeEventListener('pointercancel', onCancel, true);
                this.activeDragCleanups.delete(cleanup);
                this.taskOrderDrag = null;
                bar.removeClass('is-task-order-dragging');
                this.clearTaskOrderTargets();
                this.lastInteractionScroll = null;
                if (!cancelled && moved) this.moveTaskToIndex(project, task.id, insertAt);
            };
            const onUp = (upEvt) => {
                if (upEvt.pointerId === pointerId) cleanup(false);
            };
            const onCancel = (cancelEvt) => {
                if (cancelEvt.pointerId === pointerId) cleanup(true);
            };
            this.activeDragCleanups.add(cleanup);
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onCancel, true);
        });
    }
    taskOrderInsertionAt(track, project, topOffset, clientY) {
        const rect = track.getBoundingClientRect();
        const relativeY = clientY - rect.top - topOffset;
        return clamp(Math.round((relativeY + 6) / 42), 0, project.tasks.length);
    }
    showTaskOrderInsertion(track, project, topOffset, insertAt) {
        this.clearTaskOrderTargets();
        const dropLine = track.querySelector('.hg-task-order-drop-line');
        if (!dropLine) return;
        const top = clamp(topOffset - 6 + insertAt * 42, 2, Math.max(2, track.clientHeight - 2));
        dropLine.style.top = `${top}px`;
        dropLine.style.setProperty('--project-color', project.color);
        dropLine.addClass('is-visible');
        track.dataset.taskOrderInsertAt = String(insertAt);
    }
    bindTaskOrderTrack(track, project, topOffset) {
        if (!track || project.tasks.length < 2) return;
        const dropLine = el(track, 'div', 'hg-task-order-drop-line');
        dropLine.style.setProperty('--project-color', project.color);
    }
    async extendTimeline(direction, cellWidth) {
        if (this.timelineExtending || !this.timelinePane?.isConnected) return;
        this.timelineExtending = true;
        const pane = this.timelinePane;
        const days = clamp(Math.round(Number(this.plugin.settings.timelineExtendDays ?? TIMELINE_EXTEND_DAYS)), 15, 180);
        if (direction < 0) this.timelineExtraPast += days;
        else this.timelineExtraFuture += days;
        this.pendingTimelineRangeRestore = {
            left: pane.scrollLeft + (direction < 0 ? days * cellWidth : 0),
            top: pane.scrollTop
        };
        this.shouldScrollToday = false;
        try {
            await this.render();
        } finally {
            this.timelineExtending = false;
        }
    }
    bindInfiniteTimelineScroll(timelinePane, cellWidth) {
        if (!timelinePane) return;
        let frame = 0;
        const checkEdges = () => {
            frame = 0;
            if (!timelinePane.isConnected || this.timelineExtending || timelinePane.hasClass('is-pinching')) return;
            const max = Math.max(0, timelinePane.scrollWidth - timelinePane.clientWidth);
            if (max <= 0) return;
            if (timelinePane.scrollLeft <= TIMELINE_EDGE_THRESHOLD) this.extendTimeline(-1, cellWidth);
            else if (max - timelinePane.scrollLeft <= TIMELINE_EDGE_THRESHOLD) this.extendTimeline(1, cellWidth);
        };
        timelinePane.addEventListener('scroll', () => {
            if (frame) return;
            frame = window.requestAnimationFrame(checkEdges);
        }, { passive: true });
        // At the exact native scroll boundary Chromium may consume additional
        // trackpad/wheel movement without emitting another scroll event. Listen
        // to the horizontal intent as well so continuing the same gesture grows
        // the range instead of feeling like a hard stop.
        timelinePane.addEventListener('wheel', (evt) => {
            const horizontal = Math.abs(evt.deltaX) >= Math.abs(evt.deltaY)
                ? evt.deltaX
                : (evt.shiftKey ? evt.deltaY : 0);
            if (!horizontal || this.timelineExtending) return;
            const max = Math.max(0, timelinePane.scrollWidth - timelinePane.clientWidth);
            const threshold = TIMELINE_EDGE_THRESHOLD * 1.5;
            if (horizontal < 0 && timelinePane.scrollLeft <= threshold) this.extendTimeline(-1, cellWidth);
            else if (horizontal > 0 && max - timelinePane.scrollLeft <= threshold) this.extendTimeline(1, cellWidth);
        }, { passive: true });
    }
    bindVerticalScrollSync(labelRows, timelinePane) {
        if (!labelRows || !timelinePane) return;
        const syncScrollExtent = () => {
            if (!labelRows.isConnected || !timelinePane.isConnected) return;
            const scrollbarBottom = Math.max(0, timelinePane.offsetHeight - timelinePane.clientHeight);
            labelRows.style.setProperty('--hg-timeline-scrollbar-bottom', `${scrollbarBottom}px`);
        };
        const syncFromTimeline = () => {
            syncScrollExtent();
            labelRows.scrollTop = timelinePane.scrollTop;
        };
        timelinePane.addEventListener('scroll', syncFromTimeline, {
            passive: true
        });
        labelRows.addEventListener('wheel', (evt) => {
            if (Math.abs(evt.deltaY) >= Math.abs(evt.deltaX)) {
                syncScrollExtent();
                timelinePane.scrollTop += evt.deltaY;
                labelRows.scrollTop = timelinePane.scrollTop;
                evt.preventDefault();
            } else timelinePane.scrollLeft += evt.deltaX;
        }, {
            passive: false
        });
        syncFromTimeline();
        window.requestAnimationFrame(syncFromTimeline);
    }

    bindPinchZoom(timelinePane) {
        if (!timelinePane) return;
        let pinch = null;
        const distance = (touches) => {
            if (!touches || touches.length < 2) return 0;
            return Math.hypot(
                touches[1].clientX - touches[0].clientX,
                touches[1].clientY - touches[0].clientY
            );
        };
        const center = (touches) => ({
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2
        });
        const removeIndicator = () => {
            pinch?.indicator?.remove();
            timelinePane.removeClass('is-pinching');
        };
        const begin = (evt) => {
            if (evt.touches.length !== 2 || pinch) return;
            const startDistance = distance(evt.touches);
            if (startDistance < 8) return;
            evt.preventDefault();
            evt.stopPropagation();
            const paneRect = timelinePane.getBoundingClientRect();
            const midpoint = center(evt.touches);
            const viewportX = clamp(midpoint.x - paneRect.left, 0, timelinePane.clientWidth);
            const viewportY = clamp(midpoint.y - paneRect.top, 0, timelinePane.clientHeight);
            const configured = Number(this.plugin.settings.cellWidth || 34);
            const displayWidth = this.displayCellWidth(configured);
            const indicator = el(timelinePane, 'div', 'hg-pinch-indicator', '时间尺度 100%');
            indicator.style.left = `${timelinePane.scrollLeft + viewportX}px`;
            indicator.style.top = `${timelinePane.scrollTop + viewportY}px`;
            pinch = {
                startDistance,
                configured,
                displayWidth,
                desiredDisplayWidth: displayWidth,
                dayPosition: (timelinePane.scrollLeft + viewportX) / displayWidth,
                viewportX,
                top: timelinePane.scrollTop,
                indicator
            };
            timelinePane.addClass('is-pinching');
            this.suppressTimelineClickUntil = Date.now() + 600;
        };
        const move = (evt) => {
            if (!pinch || evt.touches.length < 2) return;
            evt.preventDefault();
            evt.stopPropagation();
            const nextDistance = distance(evt.touches);
            if (!nextDistance) return;
            const ratio = nextDistance / pinch.startDistance;
            const minDisplay = this.compactDashboardMode ? COMPACT_MIN_CELL_WIDTH : MIN_CELL_WIDTH;
            const maxDisplay = this.compactDashboardMode ? COMPACT_MAX_CELL_WIDTH : MAX_CELL_WIDTH;
            pinch.desiredDisplayWidth = clamp(pinch.displayWidth * ratio, minDisplay, maxDisplay);
            const percent = Math.round((pinch.desiredDisplayWidth / pinch.displayWidth) * 100);
            pinch.indicator.setText(`时间尺度 ${percent}%`);
            this.suppressTimelineClickUntil = Date.now() + 600;
        };
        const finish = (commit) => {
            if (!pinch) return;
            const completed = pinch;
            removeIndicator();
            pinch = null;
            this.suppressTimelineClickUntil = Date.now() + 500;
            if (!commit) return;
            const next = this.configuredCellWidthForDisplay(completed.desiredDisplayWidth);
            if (next === completed.configured) return;
            this.pendingTimelineZoomAnchor = {
                dayPosition: completed.dayPosition,
                viewportX: completed.viewportX,
                top: completed.top
            };
            this.plugin.settings.cellWidth = next;
            this.shouldScrollToday = false;
            this.plugin.saveSettings()
                .then(() => this.contentEl.isConnected && this.render())
                .catch((err) => {
                    console.error('Carrot Gantt pinch zoom failed', err);
                    this.plugin.settings.cellWidth = completed.configured;
                });
        };
        timelinePane.addEventListener('touchstart', begin, { passive: false });
        timelinePane.addEventListener('touchmove', move, { passive: false });
        timelinePane.addEventListener('touchend', (evt) => {
            if (pinch && evt.touches.length < 2) {
                evt.preventDefault();
                finish(true);
            }
        }, { passive: false });
        timelinePane.addEventListener('touchcancel', () => finish(false), { passive: false });
    }
    async zoomTimeline(direction) {
        const old = Number(this.plugin.settings.cellWidth || 34);
        const scaled = direction > 0 ? Math.ceil(old * ZOOM_FACTOR) : Math.floor(old / ZOOM_FACTOR);
        const next = clamp(scaled, MIN_CELL_WIDTH, MAX_CELL_WIDTH);
        if (next === old) return;
        if (this.timelinePane?.isConnected) {
            const oldDisplayWidth = this.displayCellWidth(old);
            this.pendingTimelineZoomAnchor = {
                dayPosition: (this.timelinePane.scrollLeft + this.timelinePane.clientWidth / 2) / oldDisplayWidth,
                viewportX: this.timelinePane.clientWidth / 2,
                top: this.timelinePane.scrollTop
            };
        }
        this.plugin.settings.cellWidth = next;
        await this.plugin.saveSettings();
        this.shouldScrollToday = false;
        await this.render();
    }
    renderProject(project, labelRows, timeRows, range, cellWidth, timelineWidth, options = {}) {
        const archived = options.archived === true || this.projectArchived(project);
        const completed = this.projectCompleted(project);
        const collapsed = archived || this.projectCollapsed(project);
        const allTasks = this.projectAllTasks(project);
        const completedCount = allTasks.filter((task) => task.done).length;
        const remaining = allTasks.length - completedCount;
        const ready = this.projectReadyToComplete(project);
        const pinned = this.projectPinned(project) && !archived && !completed;
        const height = this.projectHeight(project, { archived });
        const classes = `${archived ? ' is-archived' : ''}${collapsed ? ' is-collapsed' : ''}${completed ? ' is-completed' : ''}${pinned ? ' is-pinned' : ''}`;
        const rowLabel = el(labelRows, 'div', `hg-project-label${classes}`);
        rowLabel.dataset.projectKey = this.projectOrderKey(project);
        rowLabel.style.height = `${height}px`;
        rowLabel.style.setProperty('--project-color', project.color);
        rowLabel.addEventListener('click', (evt) => this.openProjectPopover(project, rowLabel, evt));
        rowLabel.setAttribute('role', 'button');
        rowLabel.setAttribute('tabindex', '0');
        rowLabel.setAttribute('aria-label', `编辑项目 ${project.title}`);
        rowLabel.addEventListener('keydown', (event) => {
            if (event.target !== rowLabel || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault(); this.openProjectPopover(project, rowLabel, event);
        });
        const nameLine = el(rowLabel, 'div', 'hg-project-name-line');
        const iconButton = (parent, cls, icon, title, callback) => {
            const button = el(parent, 'button', `hg-project-icon-btn ${cls}`);
            button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
            setIcon(button, icon);
            button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); callback(event); });
            return button;
        };
        if (!archived) {
            const toggle = iconButton(nameLine, 'hg-collapse-project-btn', collapsed ? 'chevron-right' : 'chevron-down', collapsed ? '展开项目' : '收起项目', () => this.withPageScrollPreserved(() => this.setProjectViewState(project, { collapsed: !collapsed })));
            toggle.setAttribute('aria-expanded', String(!collapsed));
        }
        if (this.projectSortMode() === 'manual' && !archived) {
            const handle = el(nameLine, 'span', 'hg-project-order-handle');
            setIcon(handle, 'grip-vertical'); this.bindProjectOrderHandle(handle, rowLabel, project);
        }
        el(nameLine, 'span', 'hg-color-dot');
        const name = el(nameLine, 'span', 'hg-project-name', project.title);
        name.title = project.title;
        const status = el(nameLine, 'span', 'hg-status', `${completedCount}/${allTasks.length}`);
        status.title = `全部关联任务：已完成 ${completedCount} / 总计 ${allTasks.length}；当前显示 ${project.tasks.length} 项`;
        status.setAttribute('aria-label', status.title);
        if (!archived && !completed) {
            const pin = iconButton(nameLine, `hg-pin-project-btn${pinned ? ' is-active' : ''}`, 'pin', pinned ? '取消置顶' : '置顶项目', () => this.withPageScrollPreserved(() => this.setProjectViewState(project, { pinned: !pinned })));
            pin.setAttribute('aria-pressed', String(pinned));
        }
        iconButton(nameLine, 'hg-project-menu-btn', 'ellipsis', '项目操作：完成、归档与设置', (event) => this.showProjectActionsMenu(event, project));
        const metaRow = el(rowLabel, 'div', 'hg-project-meta-row');
        metaRow.appendChild(status);
        const dateText = project.start ? `${shortDate(project.start)} → ${shortDate(project.end)}` : '未排期';
        const meta = el(metaRow, 'div', 'hg-project-meta', `${dateText} · ${project.progress}%`);
        meta.title = `${project.start || '未排期'} → ${project.end || '未排期'} · 已完成 ${completedCount} / ${allTasks.length}`;
        if (allTasks.length) {
            const progress = el(metaRow, 'div', 'hg-project-progress');
            progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', `${project.title} 完成进度`);
            progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100'); progress.setAttribute('aria-valuenow', String(project.progress));
            el(progress, 'span', 'hg-project-progress-fill').style.width = `${clamp(project.progress, 0, 100)}%`;
        }
        if ((archived || completed) && remaining) {
            const warning = el(metaRow, 'span', 'hg-project-warning', `${remaining} 项未完成`);
            warning.title = archived ? '此项目含未完成任务，可在项目操作中取消归档' : '此项目含未完成任务，可在项目操作中恢复进行中';
        } else if (archived || completed || ready) {
            el(metaRow, 'span', 'hg-project-state', archived ? '已归档' : completed ? '已完成' : '可结项');
        } else if (this.projectOverdue(project)) {
            const due = this.projectSortData(project).nextDue;
            const days = diffDays(parseDate(due), startOfDay(new Date()));
            const warning = el(metaRow, 'span', 'hg-project-warning', `逾期 ${days} 天`);
            warning.title = `项目或未完成任务最近的截止日期：${due}`;
        }
        const actions = el(rowLabel, 'div', 'hg-project-actions');
        const pinControl = nameLine.querySelector('.hg-pin-project-btn');
        if (pinControl) actions.appendChild(pinControl);
        if (pinned) {
            const dot = nameLine.querySelector('.hg-color-dot');
            dot.addClass('hg-pinned-mark'); setIcon(dot, 'pin'); dot.title = '已置顶';
        }
        const textAction = (label, cls, title, callback) => {
            const button = el(actions, 'button', `hg-button ${cls}`, label);
            button.title = title; button.type = 'button';
            button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.withPageScrollPreserved(callback); });
        };
        if (!archived && !completed) textAction('+ 任务', 'hg-add-task-btn', '添加关联任务', () => this.addTask(project));
        if (!archived && !completed && ready) textAction('标记已完成', 'hg-complete-project-btn', '结束项目并移入已完成区，保留全部任务', () => this.setProjectCompleted(project, true));
        if (!archived && completed) textAction('恢复进行中', 'hg-reopen-project-btn', '把项目恢复为进行中', () => this.setProjectCompleted(project, false));
        textAction(archived ? '取消归档' : '归档', 'hg-archive-project-btn', archived ? '恢复项目，保留原完成状态' : '收进底部归档区，保留笔记和关联任务', () => this.setProjectArchived(project, !archived));

        const track = el(timeRows, 'div', `hg-track hg-project-track${classes}`);
        track.dataset.projectKey = this.projectOrderKey(project);
        track.style.height = `${height}px`; track.style.width = `${timelineWidth}px`;
        track.style.setProperty('--project-color', project.color);
        track.style.setProperty('--cell-width', `${cellWidth}px`);
        track.style.setProperty('--workweek-width', `${cellWidth * 5}px`);
        track.style.setProperty('--week-width', `${cellWidth * 7}px`);
        track.style.setProperty('--week-offset', `${-((range.start.getDay() + 6) % 7) * cellWidth}px`);
        const setRowHover = (active) => { rowLabel.toggleClass('is-row-hover', active); track.toggleClass('is-row-hover', active); };
        for (const node of [rowLabel, track]) {
            node.addEventListener('pointerenter', () => setRowHover(true)); node.addEventListener('pointerleave', () => setRowHover(false));
        }
        if (archived) {
            el(track, 'span', 'hg-project-summary-hint', '已归档 · 打开项目设置查看关联任务');
            return;
        }
        const todayIndex = diffDays(range.start, startOfDay(new Date()));
        if (todayIndex >= 0 && todayIndex < range.days) el(track, 'div', 'hg-today-line').style.left = `${todayIndex * cellWidth + cellWidth / 2}px`;
        if (collapsed) {
            if (project.start && project.end) {
                const start = Math.max(0, diffDays(range.start, parseDate(project.start)));
                const end = Math.min(range.days, diffDays(range.start, parseDate(project.end)) + 1);
                if (end > start) {
                    const summary = el(track, 'button', 'hg-project-summary-bar', `${project.title} · ${project.progress}%`);
                    summary.type = 'button'; summary.style.left = `${start * cellWidth}px`; summary.style.width = `${Math.max(cellWidth, (end - start) * cellWidth)}px`;
                    summary.title = `展开项目 · ${project.start} → ${project.end} · ${completedCount}/${allTasks.length}`;
                    summary.addEventListener('click', () => this.withPageScrollPreserved(() => this.setProjectViewState(project, { collapsed: false })));
                }
            } else el(track, 'span', 'hg-project-summary-hint', '未排期 · 点击左侧箭头展开项目');
            return;
        }
        if (!project.tasks.length) el(track, 'div', 'hg-empty-tasks', allTasks.length ? `当前筛选未显示任务 · 共 ${allTasks.length} 项，已完成 ${completedCount} 项` : '点击左侧「+ 任务」添加属于这个项目的任务');
        const barsBlock = project.tasks.length ? (project.tasks.length - 1) * 42 + 30 : 0;
        const topOffset = project.tasks.length ? Math.max(10, Math.round((height - barsBlock) / 2)) : 14;
        if (this.taskSortMode() === 'manual') this.bindTaskOrderTrack(track, project, topOffset);
        project.tasks.forEach((task, index) => this.renderTaskBar(project, task, index, rowLabel, track, range, cellWidth, topOffset));
    }
    async updateProjectGroupSetting(group, next) {
        if (this.normalizeProjectQuery(this.projectQuery) || (this.projectFilter || 'all') === group) {
            this.projectGroupExpansion = { ...this.projectGroupExpansion, [group]: next === true };
            await this.render({ reuseBoard: true });
            return;
        }
        const key = group === 'completed' ? 'completedProjectsExpanded' : 'archivedProjectsExpanded';
        const previous = this.plugin.settings[key];
        this.plugin.settings[key] = next === true;
        try { await this.plugin.saveSettings(); }
        catch (error) { this.plugin.settings[key] = previous; new Notice(`分组设置保存失败：${error.message}`); return; }
        await this.refreshProjectViews();
    }
    async updateArchivedGroupSetting(next) {
        await this.updateProjectGroupSetting('archived', next);
    }
    renderProjectGroup(group, projects, labelRows, timeRows, range, cellWidth, timelineWidth) {
        const archived = group === 'archived';
        const expanded = this.isProjectGroupExpanded(group);
        const rowLabel = el(labelRows, 'div', `hg-archived-group hg-${group}-group`);
        rowLabel.style.height = '36px';
        const track = el(timeRows, 'div', `hg-track hg-archived-group-track hg-${group}-group-track`);
        track.style.height = '36px'; track.style.width = `${timelineWidth}px`;
        const toggle = () => this.withPageScrollPreserved(() => this.updateProjectGroupSetting(group, !expanded));
        const button = el(rowLabel, 'button', `hg-archived-toggle hg-${group}-toggle`, `${expanded ? '▾' : '▸'} ${archived ? '已归档' : '已完成'}项目 (${projects.length})`);
        button.type = 'button'; button.setAttribute('aria-expanded', String(expanded));
        button.title = `${expanded ? '收起' : '展开'}${archived ? '已归档' : '已完成'}项目`;
        button.addEventListener('click', toggle); track.addEventListener('click', toggle);
        el(track, 'span', 'hg-archived-group-hint', archived ? '保留笔记和关联任务，可随时取消归档' : '项目已结束，展开后可归档或恢复进行中');
        if (expanded) for (const project of projects) this.renderProject(project, labelRows, timeRows, range, cellWidth, timelineWidth, { archived });
    }
    renderCompletedGroup(projects, labelRows, timeRows, range, cellWidth, timelineWidth) {
        this.renderProjectGroup('completed', projects, labelRows, timeRows, range, cellWidth, timelineWidth);
    }
    renderArchivedGroup(projects, labelRows, timeRows, range, cellWidth, timelineWidth) {
        this.renderProjectGroup('archived', projects, labelRows, timeRows, range, cellWidth, timelineWidth);
    }
    taskNotesDragPatch(task, mode, nextStart, nextEnd) {
        const days = Math.max(1, diffDays(parseDate(nextStart), parseDate(nextEnd)) + 1);
        const durationMinutes = days * 24 * 60;
        switch (task.timelineMode) {
            case 'scheduled':
                if (mode === 'move') return { scheduled: nextStart };
                // TaskNotes only resizes the end of a scheduled event. Its
                // start remains scheduled and the new duration is timeEstimate.
                return { timeEstimate: durationMinutes };
            case 'due-only':
                if (mode === 'move') return { due: nextStart };
                return {};
            default:
                if (mode === 'move') return { scheduled: nextStart };
                return { scheduled: nextStart, timeEstimate: durationMinutes };
        }
    }
    bindTaskNotesDueMarkerDrag(marker, project, task, rowLabel, range, cellWidth) {
        let moved = false;
        marker.addEventListener('click', (evt) => {
            evt.stopPropagation();
            if (!moved) this.openTaskPopover(project, task, marker, evt);
        });
        marker.addEventListener('pointerdown', (evt) => {
            if (evt.button != null && evt.button !== 0) return;
            if (marker.hasClass('is-saving') || evt.pointerType === 'touch') return;
            evt.preventDefault();
            evt.stopPropagation();
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
            moved = false;
            const pointerId = evt.pointerId;
            const originalIdx = diffDays(range.start, parseDate(task.dueDate));
            const startX = evt.clientX;
            const labelMeta = rowLabel.querySelector('.hg-project-meta');
            let latestDue = task.dueDate;
            try { marker.setPointerCapture(pointerId); } catch {}
            marker.addClass('is-dragging');
            const onMove = (moveEvt) => {
                const pixelDelta = moveEvt.clientX - startX;
                const delta = Math.round(pixelDelta / cellWidth);
                if (Math.abs(pixelDelta) > 3) moved = true;
                const nextIdx = clamp(originalIdx + delta, 0, range.days - 1);
                latestDue = toYmd(addDays(range.start, nextIdx));
                marker.style.left = `${nextIdx * cellWidth + cellWidth / 2}px`;
                if (labelMeta) labelMeta.textContent = `截止 ${latestDue}`;
            };
            let finished = false;
            const cleanup = (cancelled = false, restoreVisual = true) => {
                if (finished) return;
                finished = true;
                try { marker.releasePointerCapture(pointerId); } catch {}
                marker.removeClass('is-dragging');
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                window.removeEventListener('pointercancel', onCancel, true);
                this.activeDragCleanups.delete(cleanup);
                this.lastInteractionScroll = null;
                if (cancelled) {
                    moved = false;
                    if (restoreVisual && this.contentEl.isConnected) this.render();
                    return;
                }
                if (latestDue !== task.dueDate) {
                    marker.addClass('is-saving');
                    this.updateTask(task, { due: latestDue }).then(() => {
                        if (marker.isConnected) marker.removeClass('is-saving');
                        moved = false;
                    }).catch((err) => {
                        console.error('Carrot Gantt due-date drag commit failed', err);
                        if (marker.isConnected) marker.removeClass('is-saving');
                        moved = false;
                        this.render();
                    });
                } else window.setTimeout(() => { moved = false; }, 0);
            };
            const onUp = () => cleanup(false);
            const onCancel = () => cleanup(true);
            this.activeDragCleanups.add(cleanup);
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onCancel, true);
        });
    }
    renderTaskBar(project, task, index, rowLabel, track, range, cellWidth, topOffset = 14) {
        const taskNotesMode = this.board?.mode === 'tasknotes';
        if (taskNotesMode && !task.scheduledDate && !task.dueDate) {
            const button = el(track, 'button', 'hg-unscheduled-task', `${task.title} · 未排期`);
            button.style.top = `${topOffset + index * 42}px`;
            button.setAttribute('aria-label', `编辑未排期任务 ${task.title}`);
            button.addEventListener('click', event => { event.stopPropagation(); this.openTaskPopover(project, task, button, event); });
            button.addEventListener('contextmenu', event => this.openTaskContextMenu(project, task, event));
            return;
        }
        const startIdx = diffDays(range.start, parseDate(task.start));
        const endIdx = diffDays(range.start, parseDate(task.end));
        const bar = el(track, 'div', 'hg-bar hg-task-bar');
        bar.toggleClass('is-done', task.done === true);
        bar.style.setProperty('--project-color', project.color);
        bar.style.top = `${topOffset + index * 42}px`;
        bar.style.left = `${startIdx * cellWidth + 4}px`;
        const barWidth = Math.max(30, (endIdx - startIdx + 1) * cellWidth - 8);
        bar.style.width = `${barWidth}px`;
        bar.toggleClass('is-short', barWidth < Math.min(150, Math.max(72, task.title.length * 13 + 30)));
        bar.setAttribute('role', 'button');
        bar.setAttribute('tabindex', '0');
        bar.setAttribute('aria-label', `编辑任务 ${task.title}`);
        const estimateLabel = task.timeEstimate ? ` · 预计 ${task.timeEstimate} 分钟` : '';
        const dueLabel = task.dueDate ? ` · 截止 ${task.dueDate}` : '';
        bar.setAttribute('title', taskNotesMode
            ? `${project.title} / ${task.title} · scheduled ${task.start}${estimateLabel}${dueLabel} · 状态：${task.status}`
            : `${project.title} / ${task.title}: ${task.start} → ${task.end}${estimateLabel}${dueLabel} · 状态：${task.status}`);
        // TaskNotes displays due as a separate calendar event. Do the same in
        // Gantt: the bar is scheduled + timeEstimate and the diamond is due.
        if (taskNotesMode && task.scheduledDate && task.dueDate) {
            const dueIdx = diffDays(range.start, parseDate(task.dueDate));
            if (dueIdx >= 0 && dueIdx < range.days) {
                const marker = el(track, 'span', 'hg-task-due-marker');
                marker.style.top = `${topOffset + index * 42 + 17}px`;
                marker.style.left = `${dueIdx * cellWidth + cellWidth / 2}px`;
                marker.style.setProperty('--project-color', project.color);
                marker.setAttribute('title', `${task.title} · TaskNotes due：${task.dueDate} · 拖拽只修改 due`);
                marker.setAttribute('role', 'button');
                marker.setAttribute('tabindex', '0');
                marker.setAttribute('aria-label', `${task.title} 截止于 ${task.dueDate}`);
                this.bindTaskNotesDueMarkerDrag(marker, project, task, rowLabel, range, cellWidth);
                activateOnKeyboard(marker, (evt) => this.openTaskPopover(project, task, marker, evt));
            }
        }
        const fill = el(bar, 'div', 'hg-bar-progress');
        fill.style.width = `${task.progress}%`;
        if (task.done === true) el(bar, 'span', 'hg-done-mark', '✓');
        el(bar, 'span', 'hg-bar-title', task.title);
        if (this.taskSortMode() === 'manual') {
            const taskOrderHandle = el(bar, 'span', 'hg-task-order-handle');
            setIcon(taskOrderHandle, 'grip-vertical');
            this.bindTaskOrderHandle(taskOrderHandle, bar, project, task, track, topOffset);
        }
        // TaskNotes only exposes end resizing for scheduled events. Moving the
        // bar changes scheduled; resizing its end changes timeEstimate.
        const startHandle = taskNotesMode ? null : el(bar, 'span', 'hg-resize hg-resize-start');
        const endHandle = taskNotesMode && task.timelineMode === 'due-only'
            ? null
            : el(bar, 'span', 'hg-resize hg-resize-end');
        let moved = false;
        bar.addEventListener('click', (evt) => {
            if (!moved) this.openTaskPopover(project, task, bar, evt);
        });
        activateOnKeyboard(bar, (evt) => this.openTaskPopover(project, task, bar, evt));
        bar.addEventListener('contextmenu', (evt) => this.openTaskContextMenu(project, task, evt));
        const beginDrag = (evt, mode) => {
            if (evt.button != null && evt.button !== 0) return;
            if (bar.hasClass('is-saving')) return;
            /* Touch taps should open the task, not start a drag after the
               normal few pixels of finger movement. Dates remain editable in
               the task popover; mouse and pen retain direct timeline drag. */
            if (evt.pointerType === 'touch') return;
            evt.preventDefault();
            evt.stopPropagation();
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
            moved = false;
            const pointerId = evt.pointerId;
            try {
                bar.setPointerCapture(pointerId);
            } catch {}
            bar.addClass('is-dragging');
            const originalStartIdx = diffDays(range.start, parseDate(task.start));
            const originalEndIdx = diffDays(range.start, parseDate(task.end));
            const startX = evt.clientX;
            const labelMeta = rowLabel.querySelector('.hg-project-meta');
            const preview = (delta) => {
                let newStart = originalStartIdx,
                    newEnd = originalEndIdx;
                if (mode === 'move') {
                    newStart += delta;
                    newEnd += delta;
                } else if (mode === 'start') newStart = Math.min(originalStartIdx + delta, originalEndIdx);
                else if (mode === 'end') newEnd = Math.max(originalStartIdx, originalEndIdx + delta);
                newStart = clamp(newStart, 0, range.days - 1);
                newEnd = clamp(newEnd, newStart, range.days - 1);
                bar.style.left = `${newStart * cellWidth + 4}px`;
                bar.style.width = `${Math.max(30, (newEnd - newStart + 1) * cellWidth - 8)}px`;
                const nextStart = toYmd(addDays(range.start, newStart));
                const nextEnd = toYmd(addDays(range.start, newEnd));
                if (labelMeta) labelMeta.textContent = `${nextStart} → ${nextEnd}`;
                return {
                    nextStart,
                    nextEnd
                };
            };
            let latest = {
                nextStart: task.start,
                nextEnd: task.end
            };
            const onMove = (moveEvt) => {
                const delta = Math.round((moveEvt.clientX - startX) / cellWidth);
                if (Math.abs(moveEvt.clientX - startX) > 3) moved = true;
                latest = preview(delta);
            };
            let finished = false;
            const cleanup = (cancelled = false, restoreVisual = true) => {
                if (finished) return;
                finished = true;
                try {
                    bar.releasePointerCapture(pointerId);
                } catch {}
                bar.removeClass('is-dragging');
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                window.removeEventListener('pointercancel', onCancel, true);
                this.activeDragCleanups.delete(cleanup);
                this.lastInteractionScroll = null;
                if (cancelled) {
                    moved = false;
                    if (restoreVisual && this.contentEl.isConnected) this.render();
                    return;
                }
                const changed = latest.nextStart !== task.start || latest.nextEnd !== task.end;
                if (changed) {
                    bar.addClass('is-saving');
                    const patch = this.board?.mode === 'tasknotes'
                        ? this.taskNotesDragPatch(task, mode, latest.nextStart, latest.nextEnd)
                        : { start: latest.nextStart, end: latest.nextEnd };
                    this.updateTask(task, patch).then(() => {
                        if (bar.isConnected) bar.removeClass('is-saving');
                        moved = false;
                    }).catch((err) => {
                        console.error('Carrot Gantt drag commit failed', err);
                        if (bar.isConnected) bar.removeClass('is-saving');
                        moved = false;
                        this.render();
                    });
                }
                else window.setTimeout(() => {
                    moved = false;
                }, 0);
            };
            const onUp = () => cleanup(false);
            const onCancel = () => cleanup(true);
            this.activeDragCleanups.add(cleanup);
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onCancel, true);
        };
        bar.addEventListener('pointerdown', (evt) => beginDrag(evt, 'move'));
        startHandle?.addEventListener('pointerdown', (evt) => beginDrag(evt, 'start'));
        endHandle?.addEventListener('pointerdown', (evt) => beginDrag(evt, 'end'));
    }
    openTaskContextMenu(project, task, evt) {
        evt.preventDefault();
        evt.stopPropagation();
        const anchor = evt.currentTarget;
        const menu = new Menu();
        menu.addItem((item) => item.setTitle('编辑任务').setIcon('pencil').onClick(() => this.openTaskPopover(project, task, anchor)));
        menu.addItem((item) => item.setTitle(this.board?.mode === 'tasknotes' ? '打开任务笔记' : (task.linkTarget ? '打开详情页' : '创建详情页')).setIcon('file-text').onClick(() => this.openTaskDetail(task)));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle('删除任务').setIcon('trash-2').onClick(() => this.deleteTask(task)));
        menu.showAtMouseEvent(evt);
    }

    findTask(lines, task) {
        const {
            columns
        } = parseColumns(lines);
        let line = -1;
        if (task.blockId) line = lines.findIndex((l) => TASK_RE.test(l) && l.includes(`^${task.blockId}`));
        if (line < 0 && lines[task.line]) {
            const m = TASK_RE.exec(lines[task.line]);
            if (m && (m[2].trim() === task.rawBody || cleanTaskText(m[2]) === cleanTaskText(task.rawBody))) line = task.line;
        }
        if (line < 0) line = lines.findIndex((l) => {
            const m = TASK_RE.exec(l);
            return m && cleanTaskText(m[2]) === cleanTaskText(task.rawBody);
        });
        if (line < 0) return null;
        const col = columns.find((c) => line > c.headingLine && line < c.endLine);
        return {
            line,
            endLine: taskBlockEnd(lines, line),
            column: col,
            columns
        };
    }
    buildTaskBody(task, patch) {
        const title = patch.title ?? task.title;
        const start = patch.start ?? task.start;
        const end = patch.end ?? task.end;
        const done = patch.done ?? task.done;
        const raw = task.rawBody || '';
        const base = task.linkTarget ? `[[${task.linkTarget}|${String(title).replace(/\]/g, '')}]]` : (String(title).replace(/[\r\n]+/g, ' ').trim() || '未命名任务');
        const oldBlock = task.blockId ? ` ^${task.blockId}` : '';
        const keepMarks = (raw.match(META_RE) || []).map((m) => m.trim()).filter((m) => !m.startsWith('🛫') && !m.startsWith('⏳') && !m.startsWith('📅') && !m.startsWith('✅')).join(' ');
        let body = `${base}${oldBlock}${keepMarks ? ` ${keepMarks}` : ''}`.trim();
        body = setMark(body, '✅', done ? (dateOnly(extractMark(raw, '✅')) || toYmd(new Date())) : '');
        body = setMark(body, '🛫', start);
        body = setMark(body, '📅', parseDate(end) < parseDate(start) ? start : end);
        return body;
    }
    async updateLinkedNote(task, patch) {
        const file = this.resolveLinkedFile(task);
        if (!(file instanceof TFile)) return;
        if (this.board?.mode === 'tasknotes') {
            const fields = this.taskNotesFields();
            const projField = fields.projects;
            const statusField = fields.status;
            try {
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    if (patch.project !== undefined) {
                        if (patch.project === UNASSIGNED_PROJECT) this.stripTaskProject(fm, projField, task.project);
                        else this.replaceTaskProject(fm, projField, task.project, this.canonicalProjectValue(patch.project, task));
                    }
                    if (patch.status !== undefined) fm[statusField] = patch.status || task.status;
                    if (patch.start !== undefined) patch.start ? fm[fields.scheduled] = replaceDatePart(fm[fields.scheduled], patch.start) : delete fm[fields.scheduled];
                    if (patch.end !== undefined) patch.end ? fm[fields.due] = replaceDatePart(fm[fields.due], patch.end) : delete fm[fields.due];
                    if (patch.done !== undefined) {
                        if (patch.done) {
                            fm[statusField] = this.tnCompleted;
                            fm[fields.completedDate] = toYmd(new Date());
                        } else {
                            delete fm[fields.completedDate];
                            if (this.isCompletedStatusValue(fm[statusField])) fm[statusField] = this.tnOpen;
                        }
                    }
                });
            } catch {}
            return;
        }
        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (patch.project !== undefined) fm.project = patch.project || UNASSIGNED_PROJECT;
                if (patch.status !== undefined) fm.status = patch.status || task.status;
                if (patch.start !== undefined) patch.start ? fm.start = patch.start : delete fm.start;
                if (patch.end !== undefined) patch.end ? fm.due = patch.end : delete fm.due;
                if (patch.done !== undefined) patch.done ? fm.done = toYmd(new Date()) : delete fm.done;
            });
        } catch {}
    }

    // ---------- TaskNotes write-back ----------
    async waitForTaskCacheChange(file, before, tries = 40) {
        for (let i = 0; i < tries; i++) {
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (fm && JSON.stringify(fm) !== before) return true;
            await new Promise((r) => setTimeout(r, 50));
        }
        return false;
    }
    async waitForTaskCacheFields(file, expected, tries = 80) {
        const entries = Object.entries(expected || {});
        if (!entries.length) return true;
        for (let i = 0; i < tries; i++) {
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (fm && entries.every(([key, value]) => {
                if (value == null || value === '') return !(key in fm) || fm[key] == null || fm[key] === '';
                if (typeof value === 'number') return Number(fm[key]) === value;
                return dateOnly(fm[key]) === dateOnly(value);
            })) return true;
            await new Promise((r) => setTimeout(r, 50));
        }
        return false;
    }
    sanitizeTaskTitleForFilename(title) {
        if (!title || typeof title !== 'string') return null;
        try {
            let e = title.trim().replace(/\s+/g, ' ')
                .replace(/[<>:"/\\|?*#[\]]/g, '')
                .replace(/./g, (c) => {
                    const a = c.charCodeAt(0);
                    return (a <= 31 || (a >= 127 && a <= 159)) ? '' : c;
                })
                .replace(/^\.+|\.+$/g, '').trim();
            if (!e) e = 'untitled';
            const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
            if (reserved.includes(e.toUpperCase())) e = `task-${e}`;
            return e;
        } catch {
            return null;
        }
    }
    async uniqueTaskNotesPath(file, base) {
        const parent = file.parent?.path ? `${file.parent.path}/` : '';
        const candidate = `${parent}${base}.md`;
        if (candidate === file.path) return null;
        if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
        for (let i = 2; i <= 999; i++) {
            const p = `${parent}${base}-${i}.md`;
            if (!(await this.app.vault.adapter.exists(p))) return p;
        }
        return `${parent}${base.slice(0, 50)}-${Date.now().toString(36)}.md`;
    }
    async updateTaskNotes(task, patch) {
        const file = task.file instanceof TFile ? task.file : this.resolveLinkedFile(task);
        if (!(file instanceof TFile)) return false;
        const fields = this.taskNotesFields();
        const projField = fields.projects;
        const statusField = fields.status;
        const titleField = fields.title;
        const priorityField = fields.priority;
        const transaction = this.beginInternalWrite(file);
        let overridePath = file.path;
        const scheduledPatch = patch.scheduled !== undefined ? patch.scheduled : patch.start;
        const duePatch = patch.due !== undefined ? patch.due : patch.end;
        const estimatePatch = patch.timeEstimate;
        const projectsPatch = patch.projects !== undefined
            ? [...new Set((Array.isArray(patch.projects) ? patch.projects : [patch.projects]).map((value) => String(value ?? '').trim()).filter(Boolean))]
            : undefined;
        const priorityPatch = patch.priority !== undefined ? String(patch.priority || '').trim() : undefined;
        const touchesDates = scheduledPatch !== undefined || duePatch !== undefined || estimatePatch !== undefined;
        const nextScheduled = scheduledPatch !== undefined
            ? (scheduledPatch ? replaceDatePart(task.scheduled, scheduledPatch) : '')
            : (task.scheduled || '');
        const nextDue = duePatch !== undefined
            ? (duePatch ? replaceDatePart(task.due, duePatch) : '')
            : (task.due || '');
        const nextEstimate = estimatePatch !== undefined
            ? positiveMinutes(estimatePatch)
            : positiveMinutes(task.timeEstimate);
        const expectedDates = {};
        if (scheduledPatch !== undefined) expectedDates[fields.scheduled] = scheduledPatch || null;
        if (duePatch !== undefined) expectedDates[fields.due] = duePatch || null;
        if (estimatePatch !== undefined) expectedDates[fields.timeEstimate] = positiveMinutes(estimatePatch) || null;
        if (touchesDates) {
            this.pendingTaskDateOverrides.set(overridePath, {
                scheduled: nextScheduled,
                due: nextDue,
                timeEstimate: nextEstimate,
                expiresAt: Date.now() + 15000
            });
        }
        try {
            // Update only the requested TaskNotes properties. Its bulk updateTask
            // can remove the title property when storeTitleInFilename is enabled,
            // even for a duration-only edit, exposing filename collision suffixes.
            const datePatchKeys = new Set(['scheduled', 'due', 'timeEstimate', 'start', 'end']);
            const isPureDatePatch = touchesDates && Object.keys(patch).every((key) => datePatchKeys.has(key));
            const taskNotesPlugin = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
            if (isPureDatePatch && taskNotesPlugin?.cacheManager?.getTaskInfo && taskNotesPlugin?.taskService?.updateProperty) {
                let taskInfo = await taskNotesPlugin.cacheManager.getTaskInfo(file.path);
                if (!taskInfo) throw new Error(`TaskNotes 找不到任务：${file.path}`);
                const servicePatch = {};
                if (scheduledPatch !== undefined) servicePatch.scheduled = nextScheduled || null;
                if (duePatch !== undefined) servicePatch.due = nextDue || null;
                if (estimatePatch !== undefined) servicePatch.timeEstimate = nextEstimate || null;
                for (const [property, value] of Object.entries(servicePatch)) {
                    taskInfo = await taskNotesPlugin.taskService.updateProperty(taskInfo, property, value);
                }
                const cacheReady = await this.waitForTaskCacheFields(file, expectedDates);
                const repository = this.getTaskRepository();
                if (typeof repository?.invalidate === 'function') repository.invalidate(file, null, 'gantt-tasknotes-service-commit');
                if (cacheReady) this.pendingTaskDateOverrides.delete(overridePath);
                this.plugin.refreshCarrotHome();
                await this.render();
                return true;
            }
            const touchesStatus = patch.done !== undefined || patch.status !== undefined;
            let finalStatus = patch.status ?? task.status;
            let finalDone = patch.done ?? task.done;
            let renameTo = null;
            if (patch.title !== undefined && patch.title !== task.title) {
                const base = this.sanitizeTaskTitleForFilename(patch.title);
                if (base) renameTo = await this.uniqueTaskNotesPath(file, base);
            }
            const expectFmChange =
                (patch.title !== undefined && patch.title !== task.title) ||
                (scheduledPatch !== undefined && dateOnly(scheduledPatch) !== task.scheduledDate) ||
                (duePatch !== undefined && dateOnly(duePatch) !== task.dueDate) ||
                (estimatePatch !== undefined && positiveMinutes(estimatePatch) !== positiveMinutes(task.timeEstimate)) ||
                (patch.done !== undefined && patch.done !== task.done) ||
                (patch.status !== undefined && patch.status !== task.status) ||
                (priorityPatch !== undefined && priorityPatch !== String(task.priority || '').trim()) ||
                (projectsPatch !== undefined && JSON.stringify(projectsPatch) !== JSON.stringify(task.rawProjects || [])) ||
                (patch.project !== undefined && patch.project !== task.project);
            const beforeFm = expectFmChange ? JSON.stringify(this.app.metadataCache.getFileCache(file)?.frontmatter) : undefined;
            if (patch.status !== undefined) {
                // An explicit status choice is authoritative. If the user changes
                // done -> in-progress/open, do not let the stale completed checkbox
                // force it back to the completed status.
                finalDone = this.isCompletedStatusValue(finalStatus);
            } else if (finalDone) {
                finalStatus = this.tnCompleted;
            } else if (this.isCompletedStatusValue(finalStatus)) {
                finalStatus = this.tnOpen;
            }
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (patch.title !== undefined && patch.title) fm[titleField] = patch.title;
                if (projectsPatch !== undefined) {
                    if (projectsPatch.length) fm[projField] = projectsPatch;
                    else delete fm[projField];
                } else if (patch.project !== undefined) {
                    if (patch.project === UNASSIGNED_PROJECT) this.stripTaskProject(fm, projField, task.project);
                    else this.replaceTaskProject(fm, projField, task.project, this.canonicalProjectValue(patch.project, task));
                }
                if (touchesStatus) {
                    fm[statusField] = finalStatus || this.tnOpen;
                    if (finalDone) fm[fields.completedDate] = toYmd(new Date());
                    else delete fm[fields.completedDate];
                }
                if (priorityPatch !== undefined) {
                    if (priorityPatch) fm[priorityField] = priorityPatch;
                    else delete fm[priorityField];
                }
                if (scheduledPatch !== undefined) scheduledPatch ? fm[fields.scheduled] = replaceDatePart(fm[fields.scheduled], scheduledPatch) : delete fm[fields.scheduled];
                if (duePatch !== undefined) duePatch ? fm[fields.due] = replaceDatePart(fm[fields.due], duePatch) : delete fm[fields.due];
                if (estimatePatch !== undefined) {
                    const minutes = positiveMinutes(estimatePatch);
                    if (minutes) fm[fields.timeEstimate] = Math.round(minutes);
                    else delete fm[fields.timeEstimate];
                }
                if (expectFmChange) fm[fields.dateModified] = new Date().toISOString();
            });
            if (renameTo) {
                // Same logic as TaskNotes: rename the task note file itself when
                // the title changes (storeTitleInFilename), not just the frontmatter.
                try {
                    transaction.add(renameTo);
                    await this.app.fileManager.renameFile(file, renameTo);
                    if (touchesDates && file.path !== overridePath) {
                        const pending = this.pendingTaskDateOverrides.get(overridePath);
                        this.pendingTaskDateOverrides.delete(overridePath);
                        overridePath = file.path;
                        if (pending) this.pendingTaskDateOverrides.set(overridePath, pending);
                    }
                } catch (err) {
                    console.warn('Carrot Gantt rename task note failed', err);
                }
            }
            const cacheReady = touchesDates
                ? await this.waitForTaskCacheFields(file, expectedDates)
                : (!expectFmChange || await this.waitForTaskCacheChange(file, beforeFm));
            if (patch.notes !== undefined) {
                const content = await this.app.vault.read(file);
                const fmBlock = FRONTMATTER_RE.exec(content)?.[0] || '';
                const newBody = String(patch.notes || '').trim();
                await this.app.vault.modify(file, `${fmBlock}${newBody ? `\n${newBody}\n` : ''}`);
            }
            const repository = this.getTaskRepository();
            if (typeof repository?.invalidate === 'function') repository.invalidate(file, null, 'gantt-commit');
            if (cacheReady && touchesDates) this.pendingTaskDateOverrides.delete(overridePath);
            this.plugin.refreshCarrotHome();
            await this.render();
            return true;
        } catch (err) {
            if (touchesDates) this.pendingTaskDateOverrides.delete(overridePath);
            console.error('Carrot Gantt update tasknotes task failed', err);
            new Notice('无法更新任务');
            await this.render();
            return false;
        } finally {
            transaction.release();
        }
    }
    canonicalProjectValue(projectOrTitle, excludeTask, taskFile = null) {
        const requested = typeof projectOrTitle === 'object'
            ? projectOrTitle
            : (this.board?.projects || []).find((project) => project.key === projectOrTitle || project.title === projectOrTitle) || { title: projectOrTitle };
        const requestedKey = requested?.key;
        const title = requested?.title || String(projectOrTitle || '');
        for (const t of this.board?.tasks || []) {
            if (t === excludeTask || !Array.isArray(t.rawProjects)) continue;
            for (let i = 0; i < t.rawProjects.length; i++) {
                const ref = t.projectRefs?.[i] || this.projectRefFromValue(t.rawProjects[i], t.file);
                if ((requestedKey && ref?.key === requestedKey) || (!requestedKey && ref?.title === title)) {
                    const value = this.projectValueForTask(ref, taskFile);
                    if (value) return value;
                }
            }
        }
        return this.projectValueForTask(requested, taskFile) || title;
    }
    stripTaskProject(fm, projField, title) {
        const wasArray = Array.isArray(fm[projField]);
        const arr = (wasArray ? fm[projField].slice() : (fm[projField] != null ? [fm[projField]] : []))
            .filter((v) => projectTitleFromValue(v) !== title);
        if (arr.length) fm[projField] = wasArray ? arr : arr[0];
        else delete fm[projField];
    }
    replaceTaskProject(fm, projField, oldTitle, newValue) {
        const wasArray = Array.isArray(fm[projField]);
        const arr = wasArray ? fm[projField].slice() : (fm[projField] != null ? [fm[projField]] : []);
        const idx = arr.findIndex((v) => projectTitleFromValue(v) === oldTitle);
        if (idx >= 0) arr[idx] = newValue;
        else arr.push(newValue);
        fm[projField] = wasArray ? arr : arr[0];
    }

    projectTaskFiles(project) {
        const files = [];
        const missing = [];
        const seen = new Set();
        for (const task of this.board?.tasks || []) {
            if (!this.taskBelongsToProject(task, project)) continue;
            const file = task.file instanceof TFile ? task.file : this.resolveLinkedFile(task);
            if (!(file instanceof TFile)) {
                missing.push(task.title || task.id || '未命名任务');
                continue;
            }
            if (!seen.has(file.path)) {
                seen.add(file.path);
                files.push(file);
            }
        }
        if (missing.length) throw new Error(`找不到 ${missing.length} 个任务文件：${missing.slice(0, 3).join('、')}`);
        return files;
    }

    async snapshotFiles(files) {
        const snapshots = new Map();
        for (const file of files) snapshots.set(file.path, await this.app.vault.read(file));
        return snapshots;
    }

    async restoreFileSnapshots(snapshots) {
        const failures = [];
        for (const [path, content] of snapshots || []) {
            try {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile)) throw new Error('文件不存在');
                await this.app.vault.modify(file, content);
            } catch (err) {
                failures.push(`${path}: ${err?.message || err}`);
            }
        }
        return failures;
    }

    async mutateProjectTaskFiles(project, mutate) {
        const files = this.projectTaskFiles(project);
        const snapshots = await this.snapshotFiles(files);
        const projField = String(this.tn?.fieldMapping?.projects || 'projects').trim() || 'projects';
        for (const file of files) {
            try {
                await this.app.fileManager.processFrontMatter(file, (fm) => mutate(fm, projField, file));
            } catch (err) {
                const wrapped = new Error(`${file.path}: ${err?.message || err}`);
                wrapped.cause = err;
                wrapped.snapshots = snapshots;
                throw wrapped;
            }
        }
        return { count: files.length, snapshots };
    }

    async renameTaskProjects(project, newTitle) {
        return await this.mutateProjectTaskFiles(project, (fm, projField, file) => {
            const wasArray = Array.isArray(fm[projField]);
            const arr = (wasArray ? fm[projField].slice() : (fm[projField] != null ? [fm[projField]] : []))
                .map((v) => {
                    const text = String(v || '').trim();
                    const ref = this.projectRefFromValue(v, file);
                    if (!ref || (project.key && ref.key !== project.key) || (!project.key && ref.title !== project.title)) return v;
                    const m = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/.exec(text);
                    if (m) return `[[${m[1]}|${newTitle}]]`;
                    return newTitle;
                });
            if (arr.length) fm[projField] = wasArray ? arr : arr[0];
            else delete fm[projField];
        });
    }

    async removeTaskProjectBatch(project) {
        return await this.mutateProjectTaskFiles(project, (fm, projField, file) => {
            const wasArray = Array.isArray(fm[projField]);
            const arr = (wasArray ? fm[projField].slice() : (fm[projField] != null ? [fm[projField]] : []))
                .filter((value) => {
                    const ref = this.projectRefFromValue(value, file);
                    if (!ref) return true;
                    return project.key ? ref.key !== project.key : ref.title !== project.title;
                });
            if (arr.length) fm[projField] = arr;
            else delete fm[projField];
        });
    }
    async removeProjectFromTaskNote(task, title) {
        const file = task.file instanceof TFile ? task.file : this.resolveLinkedFile(task);
        if (!(file instanceof TFile)) return;
        const projField = String(this.tn?.fieldMapping?.projects || 'projects').trim() || 'projects';
        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                this.stripTaskProject(fm, projField, title);
            });
        } catch {}
    }

    async updateTask(task, patch) {
        if (this.board?.mode === 'tasknotes') return this.updateTaskNotes(task, patch);
        if (!this.board?.file) return false;
        const file = this.board.file;
        try {
            if (patch.ensureFile && !task.linkTarget) {
                const note = await this.createTaskNote(patch.title || task.title, patch.project || task.project, patch.start || task.start, patch.end || task.end, patch.status || task.status);
                task.linkTarget = note.path.replace(/\.md$/i, '');
                task.linkedFile = note;
            }
            const lines = (await this.app.vault.read(file)).split('\n');
            const found = this.findTask(lines, task);
            if (!found) {
                new Notice('任务已在看板中变化，已刷新');
                await this.render();
                return false;
            }
            const currentLine = lines[found.line];
            const currentMatch = TASK_RE.exec(currentLine);
            if (!currentMatch) return false;
            const targetStatus = patch.status || found.column?.heading || task.status;
            const done = patch.done ?? task.done;
            const body = this.buildTaskBody({
                ...task,
                rawBody: currentMatch[2].trim(),
                blockId: blockIdFromText(currentMatch[2]) || task.blockId
            }, patch);
            const prefix = kanbanLinePrefix(currentLine, done);
            const indent = /^\s*/.exec(currentLine)?.[0] || '';
            const description = patch.notes !== undefined ? patch.notes : task.notes;
            const newBlock = [`${prefix}${body}`.trimEnd(), ...indentedDescription(description, indent)];
            if (targetStatus !== (found.column?.heading || task.status)) {
                const deleteTo = lines[found.endLine]?.trim() === '' ? found.endLine + 1 : found.endLine;
                lines.splice(found.line, deleteTo - found.line);
                const target = parseColumns(lines).columns.find((c) => c.heading === targetStatus);
                if (!target) return false;
                this.insertBlockIntoColumn(lines, target, newBlock);
            } else {
                lines.splice(found.line, found.endLine - found.line, ...newBlock);
            }
            await this.app.vault.modify(file, lines.join('\n'));
            await this.updateLinkedNote(task, patch);
            this.plugin.refreshCarrotHome();
            await this.render();
            return true;
        } catch (err) {
            console.error('Carrot Gantt update task failed', err);
            new Notice('无法更新任务');
            return false;
        }
    }
    insertBlockIntoColumn(lines, column, block) {
        let insertAt = column.headingLine + 1;
        for (let i = column.headingLine + 1; i < column.endLine; i++)
            if (TASK_RE.test(lines[i])) insertAt = taskBlockEnd(lines, i);
        if (insertAt === column.headingLine + 1 && lines[insertAt]?.trim() === '') insertAt++;
        const toInsert = [...block];
        if (lines[insertAt] != null && lines[insertAt].trim() !== '') toInsert.push('');
        lines.splice(insertAt, 0, ...toInsert);
    }
    projectLinkPathFromValue(value) {
        const m = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/.exec(String(value || '').trim());
        return m ? m[1].replace(/\.md$/i, '') : '';
    }
    resolveProjectNote(project) {
        if (!project || project.title === UNASSIGNED_PROJECT) return null;
        const candidates = [];
        if (String(project.key || '').startsWith('file:')) candidates.push(String(project.key).slice(5));
        if (project.notePath) candidates.push(project.notePath);
        for (const task of this.board?.tasks || []) {
            if (!this.taskBelongsToProject(task, project) || !Array.isArray(task.projectRefs)) continue;
            for (const ref of task.projectRefs) {
                if ((project.key && ref.key !== project.key) || (!project.key && ref.title !== project.title)) continue;
                if (ref.notePath) candidates.push(ref.notePath);
                const path = this.projectLinkPathFromValue(ref.rawValue);
                if (path) candidates.push(path);
            }
        }
        candidates.push(project.title);
        candidates.push(`${project.title}.md`);
        for (const c of candidates) {
            const raw = normalisePath(c);
            if (!raw) continue;
            const paths = [raw, raw.endsWith('.md') ? raw : `${raw}.md`];
            for (const path of paths) {
                const f = this.app.vault.getAbstractFileByPath(path) || this.app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/i, ''), '');
                if (f instanceof TFile) return f;
            }
        }
        return null;
    }
    async ensureProjectNote(project) {
        let file = this.resolveProjectNote(project);
        if (file instanceof TFile) return file;
        if (!project || project.title === UNASSIGNED_PROJECT) return null;
        let path = `${safeFilename(project.title)}.md`, n = 2;
        while (this.app.vault.getAbstractFileByPath(path)) path = `${safeFilename(project.title)} ${n++}.md`;
        file = await this.app.vault.create(path, `# ${project.title}\n\n${project.notes || ''}\n`);
        project.notePath = file.path;
        const stored = this.plugin.settings.projects || (this.plugin.settings.projects = []);
        let rec = stored.find((p) => p.id === project.id || p.title === project.title);
        if (rec) {
            rec.notePath = file.path;
            await this.plugin.saveSettings();
        }
        return file;
    }
    async renameProjectNoteFile(project, newTitle, rec) {
        if (!project || project.title === UNASSIGNED_PROJECT || !newTitle) return;
        const file = this.resolveProjectNote(project);
        if (!(file instanceof TFile)) return;
        const currentBase = file.basename;
        const oldBase = safeFilename(project.title);
        const newBase = safeFilename(newTitle);
        if (!newBase || currentBase === newBase) return;
        // Only auto-rename project notes that still look like the old project
        // note. If the user linked a custom note with a different name, keep it.
        if (currentBase !== oldBase && currentBase !== safeFilename(rec?.title || project.title)) return;
        const folder = file.parent?.path && file.parent.path !== '/' ? file.parent.path : '';
        let target = `${folder ? `${folder}/` : ''}${newBase}.md`;
        let n = 2;
        while (this.app.vault.getAbstractFileByPath(target)) {
            if (target === file.path) break;
            target = `${folder ? `${folder}/` : ''}${newBase} ${n++}.md`;
        }
        if (target !== file.path) await this.app.fileManager.renameFile(file, target);
        const renamed = this.app.vault.getAbstractFileByPath(target);
        if (renamed instanceof TFile) {
            project.notePath = renamed.path;
            if (rec) rec.notePath = renamed.path;
            try {
                const content = await this.app.vault.read(renamed);
                const updated = content.replace(/^#\s+.+$/m, `# ${newTitle}`);
                if (updated !== content) await this.app.vault.modify(renamed, updated);
            } catch {}
        }
    }

    async captureProjectNoteSnapshot(project) {
        const file = this.resolveProjectNote(project);
        if (!(file instanceof TFile)) return null;
        return {
            path: file.path,
            content: await this.app.vault.read(file)
        };
    }

    async restoreProjectNoteSnapshot(snapshot, project, rec) {
        if (!snapshot) return [];
        const failures = [];
        try {
            let current = this.app.vault.getAbstractFileByPath(project?.notePath || '') ||
                this.app.vault.getAbstractFileByPath(rec?.notePath || '') ||
                this.app.vault.getAbstractFileByPath(snapshot.path);
            if (!(current instanceof TFile)) throw new Error('找不到项目笔记');
            if (current.path !== snapshot.path) {
                const occupied = this.app.vault.getAbstractFileByPath(snapshot.path);
                if (occupied && occupied !== current) throw new Error(`无法恢复路径，目标已存在：${snapshot.path}`);
                await this.app.fileManager.renameFile(current, snapshot.path);
                current = this.app.vault.getAbstractFileByPath(snapshot.path);
            }
            if (!(current instanceof TFile)) throw new Error('恢复后找不到项目笔记');
            await this.app.vault.modify(current, snapshot.content);
            if (project) project.notePath = snapshot.path;
            if (rec) rec.notePath = snapshot.path;
        } catch (err) {
            failures.push(`${snapshot.path}: ${err?.message || err}`);
        }
        return failures;
    }

    reportProjectBatchFailure(action, err, rollbackFailures = []) {
        console.error(`Carrot Gantt ${action} failed`, err, { rollbackFailures });
        const rollbackText = rollbackFailures.length
            ? `；回滚仍有 ${rollbackFailures.length} 项失败，请查看控制台`
            : '；已恢复原数据';
        new Notice(`${action}失败：${err?.message || err}${rollbackText}`, 10000);
    }

    async openProjectNote(project) {
        if (project.title === UNASSIGNED_PROJECT) {
            new Notice('未归属项目没有项目笔记');
            return;
        }
        try {
            const file = await this.ensureProjectNote(project);
            if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
        } catch (err) {
            console.error('Carrot Gantt open project note failed', err);
            new Notice('无法打开项目笔记');
        }
    }

    async addProject() {
        new ProjectNotePickerModal(this.app, async (item) => {
            if (item instanceof TFile) {
                await this.addProjectFromFile(item);
                await this.openProjectWorkflowModal(item);
            }
        }, false).open();
    }
    async setProjectMarker(file, enabled) {
        if (!(file instanceof TFile)) return;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (enabled) fm[PROJECT_MARKER_FIELD] = true;
            else delete fm[PROJECT_MARKER_FIELD];
        });
    }
    openNewProjectTaskModal() {
        if (!this.isTaskNotesEnabled()) {
            new Notice('TaskNotes 当前未启用，无法创建项目任务');
            return;
        }
        const taskNotesPlugin = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const defaultStatus = taskNotesPlugin?.settings?.defaultTaskStatus || this.tnOpen || 'open';
        const defaultPriority = taskNotesPlugin?.settings?.defaultTaskPriority || 'normal';
        const nextColor = DEFAULT_COLORS[(this.plugin.settings.projects || []).length % DEFAULT_COLORS.length];
        new ProjectTaskCreateModal(this.app, {
            statuses: this.taskNotesStatusOptions(defaultStatus),
            priorities: this.taskNotesPriorityOptions(defaultPriority),
            defaultStatus,
            defaultPriority,
            defaultScheduled: '',
            defaultDue: '',
            defaultColor: nextColor
        }, (title, options) => this.createNewProjectTask(title, options)).open();
    }
    async addProjectFromFile(file, options = {}) {
        const ref = this.projectRefFromFile(file);
        if (!ref) return;
        if (!options.workflowTransaction) await this.setProjectMarker(file, true);
        if (options.title) ref.title = String(options.title).trim() || ref.title;
        const existingBoardProject = (this.board?.projects || []).find((project) => project.key === ref.key);
        if (existingBoardProject) {
            await this.render();
            if (!options.silentNotice) new Notice(`已将「${existingBoardProject.title}」正式标记为项目`);
            return;
        }
        const stored = this.plugin.settings.projects || (this.plugin.settings.projects = []);
        if (!stored.some((project) => project.key === ref.key || project.notePath === ref.notePath)) {
            stored.push({
                id: uid('project'),
                key: ref.key,
                title: ref.title,
                color: options.color || DEFAULT_COLORS[stored.length % DEFAULT_COLORS.length],
                notes: String(options.notes || '').trim(),
                notePath: ref.notePath,
                rawValue: ref.rawValue
            });
            if (options.workflowTransaction) {
                const record = stored[stored.length - 1];
                options.workflowTransaction.registrations.push({ ref: record, snapshot: JSON.stringify(record) });
            }
            await this.plugin.saveSettings();
        }
        await this.render();
        if (!options.silentNotice) new Notice(`已将${ref.sourceType === 'task' ? '任务' : '笔记'}作为项目：${ref.title}`);
    }
    async openProjectWorkflowModal(file) {
        if (!(file instanceof TFile)) { new Notice('请先选择已有项目笔记'); return; }
        try {
            const service = this.workflowService();
            const { fm } = await service.read(file);
            new ProjectWorkflowModal(this.app, service, file, fm.project_workflow, () => this.render()).open();
        } catch (error) { new Notice(`无法预览流程：${error.message}`); }
    }
    workflowService() { return new ProjectWorkflowService(this); }
    async createNewProjectTask(title, options = {}) {
        return this.workflowService().create(title, options);
    }
    async ensureTaskNotesCollisionTitle(taskNotesPlugin, file, title, taskInfo = null) {
        if (!(file instanceof TFile)) return taskInfo;
        const intendedTitle = String(title || '').trim();
        if (!intendedTitle || file.basename === this.sanitizeTaskTitleForFilename(intendedTitle)) return taskInfo;
        const titleField = this.taskNotesFields(taskNotesPlugin?.settings || this.tn)?.title || 'title';
        const fm = this.getLinkedFrontmatter(file);
        if (String(fm?.[titleField] ?? '').trim() === intendedTitle) return taskInfo;
        const currentTask = await taskNotesPlugin?.cacheManager?.getTaskInfo?.(file.path) || taskInfo;
        if (!currentTask || typeof taskNotesPlugin?.taskService?.updateProperty !== 'function') {
            throw new Error(`无法为重名任务「${intendedTitle}」保留 TaskNotes 标题`);
        }
        const updated = await taskNotesPlugin.taskService.updateProperty(currentTask, 'title', intendedTitle);
        return updated || currentTask;
    }
    async saveProject(project, patch) {
        const oldTitle = project.title;
        const newTitle = patch.title || oldTitle;
        if (this.board?.mode === 'tasknotes') {
            const stored = this.plugin.settings.projects || (this.plugin.settings.projects = []);
            let rec = stored.find((item) => item.id === project.id || (project.key && item.key === project.key) || (project.notePath && item.notePath === project.notePath) || item.title === oldTitle);
            if (!rec) {
                rec = { id: project.id || uid('project') };
                stored.push(rec);
            }
            rec.key = project.key;
            rec.title = newTitle;
            rec.color = patch.color || project.color;
            rec.notes = patch.notes || '';
            rec.notePath = project.notePath || rec.notePath || '';
            rec.rawValue = project.rawValue || rec.rawValue || '';
            await this.plugin.saveSettings();
            await this.render();
            new Notice('已保存甘特图显示设置；TaskNotes 项目关联未改动');
            return;
        }
        const originalProjects = JSON.parse(JSON.stringify(this.plugin.settings.projects || []));
        let noteSnapshot = null;
        let rec = null;
        let taskSnapshots = null;
        let taskCount = 0;
        try {
            noteSnapshot = await this.captureProjectNoteSnapshot(project);
            if (newTitle !== oldTitle && (this.board?.projects || []).some((p) => p !== project && p.title === newTitle)) {
                throw new Error(`项目名已存在：${newTitle}`);
            }
            const stored = this.plugin.settings.projects || (this.plugin.settings.projects = []);
            rec = stored.find((p) => p.id === project.id || p.title === oldTitle);
            if (!rec && oldTitle !== UNASSIGNED_PROJECT) {
                rec = { id: project.id || uid('project') };
                stored.push(rec);
            }
            if (rec) {
                rec.title = newTitle;
                rec.color = patch.color || project.color;
                rec.notes = patch.notes || '';
                rec.notePath = project.notePath || rec.notePath || '';
            }
            if (newTitle !== oldTitle) {
                if (this.board?.mode === 'tasknotes') {
                    const batch = await this.renameTaskProjects(project, newTitle);
                    taskSnapshots = batch.snapshots;
                    taskCount = batch.count;
                } else {
                    for (const task of this.board?.tasks || []) {
                        if (task.project !== oldTitle) continue;
                        await this.updateLinkedNote(task, { project: newTitle });
                        taskCount++;
                    }
                }
                await this.renameProjectNoteFile(project, newTitle, rec);
            }
            await this.plugin.saveSettings();
            await this.render();
            if (newTitle !== oldTitle) new Notice(`已重命名项目，同步 ${taskCount} 个任务`);
        } catch (err) {
            taskSnapshots = taskSnapshots || err?.snapshots || null;
            const rollbackFailures = [];
            rollbackFailures.push(...await this.restoreFileSnapshots(taskSnapshots));
            rollbackFailures.push(...await this.restoreProjectNoteSnapshot(noteSnapshot, project, rec));
            this.plugin.settings.projects = originalProjects;
            try { await this.plugin.saveSettings(); } catch (saveErr) {
                rollbackFailures.push(`Gantt 设置恢复失败: ${saveErr?.message || saveErr}`);
            }
            await this.render();
            this.reportProjectBatchFailure('项目修改', err, rollbackFailures);
        }
    }
    async deleteProject(project) {
        if (project.title === UNASSIGNED_PROJECT) {
            new Notice('未归属项目不能删除');
            return;
        }
        const affected = (this.board?.tasks || []).filter((task) => this.taskBelongsToProject(task, project)).length;
        if (this.board?.mode === 'tasknotes') {
            const action = project.explicit ? '取消项目标记' : '清除甘特图显示设置';
            if (!window.confirm(`${action}「${project.title}」？\n\n不会删除任务或笔记，也不会修改其他任务的 projects 属性${affected ? '；因为仍有任务关联，它将继续作为隐式项目显示' : ''}。`)) return;
            if (project.explicit) {
                const file = this.resolveProjectNote(project);
                if (file instanceof TFile) await this.setProjectMarker(file, false);
            }
            this.plugin.settings.projects = (this.plugin.settings.projects || []).filter((item) =>
                item.id !== project.id &&
                (!project.key || item.key !== project.key) &&
                (!project.notePath || item.notePath !== project.notePath) &&
                item.title !== project.title
            );
            await this.plugin.saveSettings();
            await this.render();
            new Notice(project.explicit
                ? (affected ? '已取消项目标记；因仍有子任务关联，项目继续以隐式项目显示' : '已取消项目标记，任务/笔记仍保留')
                : '已清除甘特图项目显示设置，TaskNotes 数据未改动');
            return;
        }
        if (!window.confirm(`删除项目「${project.title}」？\n\n将从 ${affected} 个相关任务中移除该项目属性，项目笔记不会被删除。`)) return;
        const originalProjects = JSON.parse(JSON.stringify(this.plugin.settings.projects || []));
        let taskSnapshots = null;
        let taskCount = 0;
        try {
            if (this.board?.mode === 'tasknotes') {
                const batch = await this.removeTaskProjectBatch(project);
                taskSnapshots = batch.snapshots;
                taskCount = batch.count;
            }
            this.plugin.settings.projects = (this.plugin.settings.projects || [])
                .filter((p) => p.id !== project.id && p.title !== project.title);
            await this.plugin.saveSettings();
            await this.render();
            new Notice(this.board?.mode === 'tasknotes'
                ? `已删除项目，并从 ${taskCount} 个任务中清除 projects 属性`
                : '已删除项目；原任务会按 project 属性保留，或进入未归属项目');
        } catch (err) {
            taskSnapshots = taskSnapshots || err?.snapshots || null;
            const rollbackFailures = [];
            rollbackFailures.push(...await this.restoreFileSnapshots(taskSnapshots));
            this.plugin.settings.projects = originalProjects;
            try { await this.plugin.saveSettings(); } catch (saveErr) {
                rollbackFailures.push(`Gantt 设置恢复失败: ${saveErr?.message || saveErr}`);
            }
            await this.render();
            this.reportProjectBatchFailure('删除项目', err, rollbackFailures);
        }
    }
    taskNotesProjectField() {
        const tn = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const mapped = tn?.fieldMapper?.toUserField?.('projects');
        return mapped || tn?.settings?.fieldMapping?.projects || 'projects';
    }
    // TaskNotes marks a note archived by adding its configured archive TAG to the note's tags
    // (not by a property), so reading and writing the flag must both go through tags. Never
    // hard-code the tag name.
    projectArchiveTag() {
        const tn = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const mapped = tn?.fieldMapper?.toUserField?.('archiveTag');
        return mapped || tn?.settings?.fieldMapping?.archiveTag || 'archived';
    }
    noteTags(file) {
        const fm = this.getLinkedFrontmatter(file) || {};
        const declared = Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags === 'string' ? fm.tags.split(/[,\s]+/) : []);
        const cached = (this.app.metadataCache?.getFileCache?.(file)?.tags || []).map((entry) => (typeof entry === 'string' ? entry : entry?.tag));
        return [...declared, ...cached]
            .filter((tag) => tag != null && tag !== '')
            .map((tag) => String(tag).trim().replace(/^#/, ''))
            .filter(Boolean);
    }
    hasArchiveTag(value) {
        const tag = this.projectArchiveTag().toLowerCase();
        const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,\s]+/) : []);
        return list.some((entry) => String(entry).trim().replace(/^#/, '').toLowerCase() === tag);
    }
    // Obsidian's metadata cache lags a moment behind a write, so a project that was just
    // archived would still render as active. The override keeps the row where the user put it
    // and expires as soon as the cache agrees (or after a few seconds, whichever comes first).
    setArchivedOverride(file, value) {
        if (!(file instanceof TFile)) return;
        this.archivedOverrides = this.archivedOverrides || new Map();
        this.archivedOverrides.set(`file:${file.path}`, { value, until: Date.now() + ARCHIVE_OVERRIDE_MS });
    }
    archivedStateFor(key, fileSays) {
        const pending = this.archivedOverrides?.get?.(key);
        if (!pending) return fileSays;
        if (pending.value === fileSays || pending.until <= Date.now()) {
            this.archivedOverrides.delete(key);
            return fileSays;
        }
        return pending.value;
    }
    projectArchived(project) {
        if (!project || project.title === UNASSIGNED_PROJECT) return false;
        const file = this.projectNoteFileForDelete(project);
        if (!(file instanceof TFile)) return false;
        return this.archivedStateFor(`file:${file.path}`, this.hasArchiveTag(this.noteTags(file)));
    }
    async setProjectArchived(project, archived) {
        if (!project || project.title === UNASSIGNED_PROJECT) { new Notice('未归属项目不能归档'); return; }
        const file = this.projectNoteFileForDelete(project);
        if (!(file instanceof TFile)) { new Notice('找不到项目笔记，无法归档'); return; }
        const tag = this.projectArchiveTag();
        const current = this.projectArchived(project);
        if (current === archived) { await this.render(); return; }
        const tn = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
        const movable = tn?.settings?.moveArchivedTasks === true;
        try {
            const info = tn?.cacheManager?.getCachedTaskInfoSync?.(file.path) || await tn?.cacheManager?.getTaskInfo?.(file.path);
            // TaskNotes' toggle is used only when its cached state agrees with the file, so a
            // stale cache can never flip the flag the wrong way. When TaskNotes is set to move
            // archived notes, the tag is written in place instead: the Gantt project identity is
            // the note path, and a move would orphan the project row.
            const usableToggle = !movable
                && typeof tn?.taskService?.toggleArchive === 'function'
                && this.isTaskNotesTaskFile(file)
                && info && this.hasArchiveTag(info.tags) === current;
            if (usableToggle) await tn.taskService.toggleArchive(info);
            else await this.app.fileManager.processFrontMatter(file, (fm) => {
                const declared = Array.isArray(fm.tags) ? fm.tags.map(String) : (typeof fm.tags === 'string' ? fm.tags.split(/[,\s]+/) : []);
                const kept = declared.filter((entry) => String(entry).trim().replace(/^#/, '') !== tag);
                const next = archived ? [...kept, tag] : kept;
                if (next.length) fm.tags = next;
                else delete fm.tags;
            });
        } catch (error) {
            console.error('Carrot Gantt archive project failed', error);
            new Notice(`归档失败：${error?.message || error}`);
            return;
        }
        this.setArchivedOverride(file, archived);
        this.plugin.refreshCarrotHome();
        await this.refreshProjectViews();
        const suffix = archived && movable ? '（保留笔记原位置和项目关联）' : '';
        new Notice(archived ? `已归档项目「${project.title}」，它折叠在甘特图最下方${suffix}` : `已取消归档「${project.title}」`);
    }
    // A project note is only deletable while its identity is explicit: either the key or
    // note path recorded for this project, or the note itself carrying the Carrot Gantt
    // project marker. A file that only shares the project's name is never deleted.
    projectNoteFileForDelete(project) {
        if (!project || project.title === UNASSIGNED_PROJECT) return null;
        const candidates = [];
        if (String(project.key || '').startsWith('file:')) candidates.push(String(project.key).slice(5));
        if (project.notePath) candidates.push(project.notePath);
        for (const candidate of candidates) {
            const raw = normalisePath(candidate);
            if (!raw) continue;
            const file = this.app.vault.getAbstractFileByPath(raw);
            if (file instanceof TFile) return file;
        }
        const resolved = this.resolveProjectNote(project);
        if (resolved instanceof TFile && this.isProjectMarkerValue((this.getLinkedFrontmatter(resolved) || {})[PROJECT_MARKER_FIELD])) return resolved;
        return null;
    }
    recordedProjectNotePath(project) {
        if (String(project?.key || '').startsWith('file:')) return normalisePath(String(project.key).slice(5));
        return normalisePath(project?.notePath || '');
    }
    // Cascade membership is computed from the files themselves, not from what the current
    // dashboard card happens to show, so hidden or filtered members are deleted too. The
    // identity path also survives a partial delete, where the note is already gone.
    projectCascadeTargets(project) {
        const note = this.projectNoteFileForDelete(project);
        const identityPath = (note instanceof TFile ? note.path : this.recordedProjectNotePath(project)) || '';
        if (!identityPath) return { note: null, tasks: [], shared: 0, identityPath: '' };
        const field = this.taskNotesProjectField();
        const tasks = [];
        let shared = 0;
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (file === note) continue;
            if (!this.isTaskNotesTaskFile(file)) continue;
            const fm = this.getLinkedFrontmatter(file) || {};
            const values = (Array.isArray(fm[field]) ? fm[field] : (fm[field] == null ? [] : [fm[field]])).filter(value => typeof value === 'string' && value.trim());
            // Match on the resolved identity and on the written path, because a reference to
            // an already-deleted note no longer resolves to any file.
            const matches = values.some(value => {
                const ref = this.projectRefFromValue(value, file);
                if (ref && (ref.key === `file:${identityPath}` || ref.notePath === identityPath)) return true;
                const parts = projectLinkParts(value);
                const target = normalisePath(parts.target.endsWith('.md') ? parts.target : `${parts.target}.md`);
                return !!target && target === identityPath;
            });
            if (!matches) continue;
            if (values.length > 1) shared++;
            tasks.push(file);
        }
        return { note, tasks, shared, identityPath };
    }
    // Follow the vault's own "Deleted files" setting instead of assuming the system trash;
    // the user's vault is configured for the local .trash folder.
    deleteFilePlan() {
        const option = this.app.vault?.getConfig?.('trashOption');
        if (option === 'none') return { permanent: true, system: false, label: '' };
        if (option === 'local') return { permanent: false, system: false, label: ' vault 内的 .trash 文件夹（可恢复）' };
        return { permanent: false, system: true, label: '系统回收站（可恢复）' };
    }
    async removeFile(file, plan) {
        if (plan?.permanent) return this.app.vault.delete(file);
        return this.app.vault.trash(file, plan?.system !== false);
    }
    async deleteProjectAndTasks(project) {
        if (!project || project.title === UNASSIGNED_PROJECT) { new Notice('未归属项目不能删除'); return; }
        if (this.board?.mode !== 'tasknotes') { new Notice('只有 TaskNotes 数据源支持删除项目及任务'); return; }
        const { note, tasks, shared } = this.projectCascadeTargets(project);
        if (!(note instanceof TFile) && !tasks.length) { new Notice('没有可识别的项目笔记或关联任务，无法删除'); return; }
        const listing = tasks.slice(0, 8).map((file) => `· ${file.path}`).join('\n');
        const body = [note instanceof TFile ? `· 项目笔记：${note.path}` : '· 项目笔记已经不在库里',
            tasks.length ? `· 关联任务 ${tasks.length} 个${shared ? `，其中 ${shared} 个同时属于其他项目，也会一起删除` : ''}：\n${listing}${tasks.length > 8 ? `\n· …还有 ${tasks.length - 8} 个任务` : ''}` : '· 没有关联任务'
        ].join('\n');
        const total = tasks.length + (note instanceof TFile ? 1 : 0);
        const plan = this.deleteFilePlan();
        if (!window.confirm(`删除项目「${project.title}」？\n\n以下 ${total} 个笔记会${plan.permanent ? '永久删除，无法恢复' : `移入${plan.label}`}：\n${body}\n\n其他项目的任务和未关联的笔记不会被删除。`)) return;
        const service = this.workflowService?.();
        let releaseLock = () => {};
        if (typeof service?.holdParentLock === 'function') {
            try { releaseLock = service.holdParentLock((note instanceof TFile ? note.path : this.recordedProjectNotePath(project)) || project.title, `deleting:${project.key || project.title}`); }
            catch (error) { new Notice(error?.message || '该项目正在处理另一项流程操作，请稍后重试'); return; }
        }
        const removed = [], kept = [];
        try {
            for (const file of [...tasks, ...(note instanceof TFile ? [note] : [])]) {
                if (this.app.vault.getAbstractFileByPath(file.path) !== file) { kept.push(file.path); continue; }
                try { await this.removeFile(file, plan); removed.push(file.path); }
                catch { kept.push(file.path); }
            }
        } finally { releaseLock(); }
        if (kept.length) {
            console.error('Carrot Gantt delete project leftovers', kept);
            this.plugin.refreshCarrotHome();
            await this.render();
            new Notice(`已删除 ${removed.length} 个笔记，${kept.length} 个没删掉（已不存在或回收站失败）：${kept.join('、')}。项目设置保留，可重试。`);
            return;
        }
        this.plugin.settings.projects = (this.plugin.settings.projects || []).filter(item =>
            item.id !== project.id &&
            (!project.key || item.key !== project.key) &&
            (!project.notePath || item.notePath !== project.notePath) &&
            item.title !== project.title);
        try { await this.plugin.saveSettings(); }
        catch (error) { new Notice(`项目已删除，但甘特图设置保存失败：${error?.message || error}。请重试保存设置。`); }
        this.plugin.refreshCarrotHome();
        await this.render();
        new Notice(`已删除项目「${project.title}」及 ${removed.length} 个笔记（可在系统回收站恢复）`);
    }
    async unlinkProjectFromAllTasks(project) {
        if (!project || project.title === UNASSIGNED_PROJECT) return;
        const affected = (this.board?.tasks || []).filter((task) => this.taskBelongsToProject(task, project)).length;
        if (!affected) {
            new Notice('没有任务关联该项目');
            return;
        }
        if (!window.confirm(`从 ${affected} 个任务的 projects 属性中解除「${project.title}」？\n\n这会修改 TaskNotes 任务笔记，项目笔记本身不会被删除。`)) return;
        let snapshots = null;
        try {
            const batch = await this.removeTaskProjectBatch(project);
            snapshots = batch.snapshots;
            this.plugin.refreshCarrotHome();
            await this.render();
            new Notice(`已从 ${batch.count} 个任务中解除项目关联`);
        } catch (err) {
            snapshots = snapshots || err?.snapshots || null;
            const rollbackFailures = await this.restoreFileSnapshots(snapshots);
            await this.render();
            this.reportProjectBatchFailure('解除项目关联', err, rollbackFailures);
        }
    }
    defaultStatus() {
        if (this.board?.mode === 'tasknotes') return this.tnOpen || 'open';
        const columns = this.board?.columns || [];
        return (columns.find((c) => !looksDoneColumn(c.heading)) || columns[0])?.heading || '代办';
    }
    async addTask(project) {
        if (!this.board) return;
        if (this.board.mode === 'tasknotes') return this.addTaskNotes(project);
        if (!this.board?.file) return;
        const start = toYmd(new Date()),
            end = toYmd(addDays(new Date(), 3)),
            status = this.defaultStatus();
        try {
            const note = await this.createTaskNote('新任务', project.title, start, end, status);
            const link = this.app.fileManager.generateMarkdownLink(note, this.board.file.path);
            const body = `${link} ^${uid('t').replace(/[^A-Za-z0-9_-]/g, '')} 🛫 ${start} 📅 ${end}`;
            const lines = (await this.app.vault.read(this.board.file)).split('\n');
            const column = parseColumns(lines).columns.find((c) => c.heading === status) || parseColumns(lines).columns[0];
            if (!column) return;
            this.insertBlockIntoColumn(lines, column, [`- [ ] ${body}`]);
            await this.app.vault.modify(this.board.file, lines.join('\n'));
            this.plugin.refreshCarrotHome();
            await this.render();
            new Notice(`已在「${project.title}」添加任务；看板状态：${status}`);
        } catch (err) {
            console.error('Carrot Gantt add task failed', err);
            new Notice('无法添加任务');
        }
    }
    async addTaskNotes(project) {
        try {
            const taskNotesPlugin = this.app.plugins?.plugins?.[TASKNOTES_PLUGIN_ID];
            if (typeof taskNotesPlugin?.openTaskCreationModal !== 'function') {
                throw new Error('TaskNotes 任务创建器不可用');
            }
            const projectValue = this.projectValueForTask(project, '');
            if (!projectValue) throw new Error('无法解析项目笔记');
            // Delegate creation to TaskNotes itself. Its modal applies the same
            // defaults, date presets, custom fields, tags, reminders, filename
            // rules and validation as every other TaskNotes creation entry.
            // Carrot Gantt pre-populates only the selected project relationship.
            taskNotesPlugin.openTaskCreationModal({ projects: [projectValue] });
        } catch (err) {
            console.error('Carrot Gantt add tasknotes task failed', err);
            new Notice(`无法打开 TaskNotes 新建任务：${err?.message || err}`);
        }
    }
    async createTaskNote(title, project, start, due, status) {
        const boardPath = this.board?.file?.path || '';
        const folderPath = boardPath.includes('/') ? boardPath.split('/').slice(0, -1).join('/') : '';
        const base = safeFilename(title);
        let path = `${folderPath ? `${folderPath}/` : ''}${base}.md`,
            n = 2;
        while (this.app.vault.getAbstractFileByPath(path)) path = `${folderPath ? `${folderPath}/` : ''}${base} ${n++}.md`;
        const body = `---\nproject: ${JSON.stringify(project || UNASSIGNED_PROJECT)}\nstatus: ${JSON.stringify(status || this.defaultStatus())}\nstart: ${start}\ndue: ${due}\n---\n\n# ${title}\n`;
        return await this.app.vault.create(path, body);
    }
    async ensureTaskNote(task, title) {
        const existing = this.resolveLinkedFile(task);
        if (existing instanceof TFile) return existing;
        await this.updateTask(task, {
            title: title || task.title,
            project: task.project,
            status: task.status,
            start: task.start,
            end: task.end,
            ensureFile: true
        });
        await this.loadBoard().then((b) => {
            if (b) this.board = b;
        });
        return this.resolveLinkedFileFromTarget(task.linkTarget);
    }
    async openTaskDetail(task) {
        let file = this.resolveLinkedFile(task);
        if (!(file instanceof TFile)) {
            const ok = await this.updateTask(task, {
                title: task.title,
                project: task.project,
                status: task.status,
                start: task.start,
                end: task.end,
                ensureFile: true
            });
            file = ok ? task.linkedFile : null;
        }
        if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
    }
    attachTopbarToCarrotHomeHeader(topbar) {
        const move = () => {
            if (!topbar || !topbar.isConnected || !this.rootEl?.isConnected) return;
            const card = this.rootEl.closest?.('.hearth-card');
            const head = card?.querySelector?.(':scope > .hearth-card-head');
            if (!head) return;
            const existing = head.querySelector(':scope > .hg-topbar.hg-topbar-in-card-head');
            if (existing && existing !== topbar) existing.remove();
            topbar.addClass('hg-topbar-in-card-head');
            head.appendChild(topbar);
            this.headerTopbar = topbar;
        };
        move();
        window.requestAnimationFrame(move);
    }

    async openGanttInNewTab() {
        try {
            let leaf;
            try {
                leaf = this.app.workspace.getLeaf('tab');
            } catch {
                leaf = this.app.workspace.getLeaf(true);
            }
            await leaf.setViewState({
                type: VIEW_TYPE,
                active: true
            });
            this.app.workspace.revealLeaf(leaf);
        } catch (err) {
            console.error('Carrot Gantt open new tab failed', err);
            new Notice('无法在新标签页打开甘特图');
        }
    }
    async openTaskBoard() {
        /* Compact Home mode intentionally does not load the whole board. Resolve
           only the source when this button is actually pressed, otherwise the
           lightweight launcher would have a button with no destination. */
        let mode = this.board?.mode || '';
        let boardFile = this.board?.file || null;
        if (!mode) {
            try {
                const source = await this.getTaskSource();
                mode = source?.mode || '';
                boardFile = source?.file || null;
            } catch (err) {
                console.error('Carrot Gantt resolve task source failed', err);
            }
        }
        if (mode === 'tasknotes') {
            const tn = this.tn || await this.getTaskNotesSettings();
            const mapped = normalisePath(tn?.commandFileMapping?.['open-tasks-view'] || 'TaskNotes/Views/tasks-default.base');
            const candidates = [mapped, 'TaskNotes/Views/tasks-default.base'];
            for (const path of candidates) {
                try {
                    const file = this.app.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile) {
                        const leaf = this.app.workspace.getLeaf('tab');
                        await leaf.openFile(file, { active: true });
                        this.app.workspace.revealLeaf(leaf);
                        return;
                    }
                } catch {}
            }
            try {
                const ok = this.app.commands?.executeCommandById?.('tasknotes:open-tasks-view');
                if (ok !== false) return;
            } catch (err) {
                console.error('Carrot Gantt open TaskNotes tasks command failed', err);
            }
            const first = this.board?.tasks?.find((t) => t.file instanceof TFile)?.file;
            if (first instanceof TFile) {
                await this.app.workspace.getLeaf(true).openFile(first);
                return;
            }
            new Notice('无法打开 TaskNotes 任务列表，请确认 TaskNotes 插件已启用');
            return;
        }
        if (boardFile instanceof TFile) {
            await this.app.workspace.getLeaf(true).openFile(boardFile);
            return;
        }
        new Notice('没有找到可打开的任务源');
    }
    async deleteTask(task) {
        if (this.board?.mode === 'tasknotes') {
            const file = task.file instanceof TFile ? task.file : null;
            if (!file) return;
            try {
                await this.app.vault.trash(file, true);
                this.plugin.refreshCarrotHome();
                await this.render();
                new Notice('已删除任务（可在系统回收站恢复）');
            } catch (err) {
                console.error('Carrot Gantt delete tasknotes task failed', err);
                new Notice('无法删除任务');
            }
            return;
        }
        if (!this.board?.file) return;
        try {
            const lines = (await this.app.vault.read(this.board.file)).split('\n');
            const found = this.findTask(lines, task);
            if (!found) return;
            const deleteTo = lines[found.endLine]?.trim() === '' ? found.endLine + 1 : found.endLine;
            lines.splice(found.line, deleteTo - found.line);
            await this.app.vault.modify(this.board.file, lines.join('\n'));
            this.plugin.refreshCarrotHome();
            await this.render();
            new Notice('已从看板删除任务卡片');
        } catch {
            new Notice('无法删除任务');
        }
    }

    closePopover() {
        if (this.popover) {
            this.popover.remove();
            this.popover = null;
        }
        if (this.outsideHandler) {
            window.removeEventListener('pointerdown', this.outsideHandler, true);
            this.outsideHandler = null;
        }
    }
    placePopover(pop, anchor) {
        const rootRect = this.rootEl.getBoundingClientRect();
        const anchorRect = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : rootRect;
        const margin = 12;
        const viewportW = window.innerWidth || document.documentElement.clientWidth || rootRect.right;
        const viewportH = window.innerHeight || document.documentElement.clientHeight || rootRect.bottom;
        const availableWidth = Math.max(0, Math.min(rootRect.width - margin * 2, viewportW - margin * 2));
        const popW = Math.max(0, Math.min(pop.offsetWidth || 380, availableWidth));
        pop.style.width = `${popW}px`;
        pop.style.maxWidth = `${popW}px`;
        let leftVp = anchorRect.left + 16;
        const minLeft = Math.max(rootRect.left + margin, margin);
        const maxLeft = Math.min(rootRect.right - popW - margin, viewportW - popW - margin);
        leftVp = clamp(leftVp, minLeft, Math.max(minLeft, maxLeft));

        const popH = Math.min(pop.offsetHeight || 520, rootRect.height - margin * 2, viewportH - margin * 2);
        let topVp = anchorRect.bottom + 8;
        const maxTop = Math.min(rootRect.bottom - popH - margin, viewportH - popH - margin);
        if (topVp > maxTop && anchorRect.top - popH - 8 >= Math.max(rootRect.top + margin, margin)) {
            topVp = anchorRect.top - popH - 8;
        }
        const minTop = Math.max(rootRect.top + margin, margin);
        topVp = clamp(topVp, minTop, Math.max(minTop, maxTop));

        pop.style.left = `${Math.round(leftVp - rootRect.left)}px`;
        pop.style.top = `${Math.round(topVp - rootRect.top)}px`;
        this.outsideHandler = (outsideEvt) => {
            if (!pop.contains(outsideEvt.target)) this.closePopover();
        };
        window.setTimeout(() => window.addEventListener('pointerdown', this.outsideHandler, true), 0);
    }
    makePopover(title, color, anchor, evt) {
        if (evt) {
            evt.preventDefault();
            evt.stopPropagation();
        }
        this.closePopover();
        if (!this.rootEl) return null;
        const pop = el(this.rootEl, 'div', 'hg-popover');
        pop.style.setProperty('--project-color', color);
        this.popover = pop;
        const header = el(pop, 'div', 'hg-popover-header');
        el(header, 'div', 'hg-popover-title', title);
        const closeBtn = el(header, 'button', 'hg-icon-btn', '×');
        closeBtn.addEventListener('click', () => this.closePopover());
        this.placePopover(pop, anchor);
        return pop;
    }
    makeField(pop, label, input) {
        const field = el(pop, 'label', 'hg-field');
        el(field, 'span', '', label);
        field.appendChild(input);
        return input;
    }
    makeColorPresetField(pop, label, currentColor, onChange) {
        const field = el(pop, 'div', 'hg-field hg-color-preset-field');
        el(field, 'span', '', label);
        const palette = el(field, 'div', 'hg-color-presets');
        const choices = DEFAULT_COLORS;
        let selected = choices.includes(currentColor) ? currentColor : choices[0];
        const buttons = [];
        const sync = () => {
            for (const btn of buttons) btn.toggleClass('is-selected', btn.dataset.color === selected);
            onChange(selected);
        };
        for (const color of choices) {
            const btn = el(palette, 'button', 'hg-color-preset');
            btn.type = 'button';
            btn.dataset.color = color;
            btn.style.setProperty('--preset-color', color);
            btn.setAttribute('aria-label', `选择颜色 ${color}`);
            btn.setAttribute('title', color);
            btn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                selected = color;
                sync();
            });
            buttons.push(btn);
        }
        sync();
        return {
            get value() {
                return selected;
            },
            set value(v) {
                selected = choices.includes(v) ? v : choices[0];
                sync();
            }
        };
    }
    makeProjectTaskList(pop, project) {
        const field = el(pop, 'div', 'hg-field hg-project-task-field');
        const heading = el(field, 'div', 'hg-project-task-heading');
        el(heading, 'span', '', '关联任务');
        el(heading, 'span', 'hg-project-task-count', `${this.projectAllTasks(project).length} 项`);
        const list = el(field, 'div', 'hg-project-task-list');
        const tasks = this.projectAllTasks(project);
        if (!tasks.length) {
            el(list, 'div', 'hg-project-task-empty', '暂无关联任务');
            return;
        }
        for (const task of tasks) {
            const row = el(list, 'div', 'hg-project-task-row');
            row.toggleClass('is-done', task.done === true);
            const check = el(row, 'span', 'hg-project-task-state', task.done ? '✓' : '');
            check.setAttribute('aria-hidden', 'true');
            el(row, 'span', 'hg-project-task-title', task.title || '未命名任务');
            const date = task.dueDate || task.scheduledDate || '';
            if (date) el(row, 'span', 'hg-project-task-date', date);
        }
    }
    openProjectPopover(project, anchor, evt) {
        const popoverScrollSnapshot = this.lastInteractionScroll || this.capturePageScroll();
        const pop = this.makePopover('项目设置', project.color, anchor, evt);
        if (!pop) return;
        const titleInput = this.makeField(pop, this.board?.mode === 'tasknotes' ? '项目名称（来自任务/笔记）' : '项目名', el(document.body, 'input', 'hg-input'));
        titleInput.value = project.title;
        titleInput.disabled = project.title === UNASSIGNED_PROJECT || this.board?.mode === 'tasknotes';
        let selectedColor = project.color || DEFAULT_COLORS[0];
        const colorInput = this.makeColorPresetField(pop, '项目颜色', selectedColor, (color) => {
            selectedColor = color;
            pop.style.setProperty('--project-color', color);
        });
        this.makeProjectTaskList(pop, project);
        const notesInput = this.makeField(pop, '备注', el(document.body, 'textarea', 'hg-input hg-textarea'));
        notesInput.rows = 3;
        notesInput.value = project.notes || '';
        const footer = el(pop, 'div', 'hg-popover-actions');
        const projectTools = el(pop, 'div', 'hg-project-management-actions');
        footer.before(projectTools);
        const manageButton = (label, callback) => {
            const button = el(projectTools, 'button', 'hg-button', label);
            button.type = 'button';
            button.addEventListener('click', () => this.withPageScrollPreserved(callback));
        };
        if (!this.projectArchived(project)) {
            if (!this.projectCompleted(project)) manageButton(this.projectPinned(project) ? '取消置顶' : '置顶项目', () => this.setProjectViewState(project, { pinned: !this.projectPinned(project) }));
            manageButton(this.projectCollapsed(project) ? '展开项目' : '收起项目', () => this.setProjectViewState(project, { collapsed: !this.projectCollapsed(project) }));
            manageButton(this.projectCompleted(project) ? '恢复进行中' : '标记已完成', () => this.setProjectCompleted(project, !this.projectCompleted(project)));
        }
        if (this.board?.mode === 'tasknotes') {
            const workflowButton = el(footer, 'button', 'hg-button', '补齐流程子任务');
            const projectFile = project.notePath ? this.app.vault.getAbstractFileByPath(project.notePath) : this.resolveProjectNote(project);
            workflowButton.disabled = !(projectFile instanceof TFile);
            workflowButton.addEventListener('click', () => this.openProjectWorkflowModal(projectFile));
        }
        if (this.board?.mode === 'tasknotes') {
            const archivedNow = this.projectArchived(project);
            const archiveBtn = el(footer, 'button', 'hg-button', archivedNow ? '取消归档' : '归档项目');
            archiveBtn.setAttribute('title', archivedNow ? '取消归档，项目会回到上方列表' : '归档后项目折叠到甘特图最下方，完成状态不受影响');
            archiveBtn.disabled = project.title === UNASSIGNED_PROJECT;
            archiveBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.setProjectArchived(project, !archivedNow)));
        }
        const openProjectBtn = el(footer, 'button', 'hg-button', project.notePath || this.resolveProjectNote(project) ? '打开项目笔记' : '创建项目笔记');
        const addTaskBtn = el(footer, 'button', 'hg-button', '+ 添加任务');
        const cascadeBtn = this.board?.mode === 'tasknotes' ? el(footer, 'button', 'hg-button hg-danger', '删除项目及任务…') : null;
        const deleteBtn = el(footer, 'button', 'hg-button hg-danger', this.board?.mode === 'tasknotes'
            ? (project.explicit ? '取消项目标记' : '清除显示设置')
            : '删除项目');
        const unlinkBtn = this.board?.mode === 'tasknotes' ? el(footer, 'button', 'hg-button hg-danger', '从所有任务解除关联') : null;
        const saveBtn = el(footer, 'button', 'hg-button hg-primary', '保存');
        deleteBtn.disabled = project.title === UNASSIGNED_PROJECT;
        if (cascadeBtn) {
            cascadeBtn.setAttribute('title', '把项目笔记和它下面的关联任务一起移入系统回收站');
            cascadeBtn.disabled = project.title === UNASSIGNED_PROJECT;
        }
        if (this.board?.mode === 'tasknotes') deleteBtn.setAttribute('title', '只取消项目标记或清除甘特图显示设置，不删除任何笔记');
        if (unlinkBtn) unlinkBtn.disabled = project.title === UNASSIGNED_PROJECT;
        saveBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.saveProject(project, {
            title: titleInput.value.trim(),
            color: selectedColor,
            notes: notesInput.value.trim()
        })));
        openProjectBtn.disabled = project.title === UNASSIGNED_PROJECT;
        openProjectBtn.addEventListener('click', () => this.openProjectNote(project));
        addTaskBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.addTask(project)));
        deleteBtn.addEventListener('click', () => this.withPageScrollPreserved(() => this.deleteProject(project)));
        cascadeBtn?.addEventListener('click', () => this.withPageScrollPreserved(() => this.deleteProjectAndTasks(project)));
        unlinkBtn?.addEventListener('click', () => this.withPageScrollPreserved(() => this.unlinkProjectFromAllTasks(project)));
        this.placePopover(pop, anchor);
        this.restorePageScroll(popoverScrollSnapshot);
    }
    openTaskPopover(project, task, anchor, evt) {
        const popoverScrollSnapshot = this.lastInteractionScroll || this.capturePageScroll();
        const pop = this.makePopover('任务设置', project.color, anchor, evt);
        if (!pop) return;
        pop.addClass('hg-task-popover');
        this.placePopover(pop, anchor);
        const isTaskNotes = this.board?.mode === 'tasknotes';
        el(pop, 'div', 'hg-task-project-hint', isTaskNotes ? `同一任务源：TaskNotes 任务笔记；当前状态：${task.status}` : `同一任务源：看板卡片 + 详情页 project 属性；当前看板状态：${task.status}`);
        const titleInput = this.makeField(pop, '任务名', el(document.body, 'input', 'hg-input'));
        titleInput.value = task.title;
        let projectInput = null;
        const selectedProjectRefs = new Map((task.projectRefs || []).map((ref) => [ref.key, { ...ref }]));
        if (isTaskNotes) {
            const field = el(pop, 'div', 'hg-field hg-project-multi-field');
            el(field, 'span', '', '所属项目（TaskNotes projects，可多选）');
            const summary = el(field, 'button', 'hg-project-summary');
            summary.type = 'button';
            const summaryText = el(summary, 'span', 'hg-project-summary-text');
            el(summary, 'span', 'hg-project-summary-chevron', '⌄');
            const panel = el(field, 'div', 'hg-project-multi-panel');
            panel.hidden = true;
            const list = el(panel, 'div', 'hg-project-multi-list');
            const syncSummary = () => {
                const names = [...selectedProjectRefs.values()].map((ref) => ref.title).filter(Boolean);
                summaryText.textContent = names.length ? names.join('、') : '未关联项目';
                summary.setAttribute('title', summaryText.textContent);
            };
            const renderChoices = () => {
                list.empty();
                const candidates = new Map();
                for (const item of this.board.projects || []) {
                    if (item.title !== UNASSIGNED_PROJECT) candidates.set(item.key, item);
                }
                for (const ref of selectedProjectRefs.values()) if (!candidates.has(ref.key)) candidates.set(ref.key, ref);
                for (const item of candidates.values()) {
                    const row = el(list, 'label', 'hg-project-choice');
                    const checkbox = el(row, 'input', '');
                    checkbox.type = 'checkbox';
                    checkbox.checked = selectedProjectRefs.has(item.key);
                    const dot = el(row, 'span', 'hg-project-choice-dot');
                    dot.style.setProperty('--project-color', item.color || DEFAULT_COLORS[0]);
                    el(row, 'span', 'hg-project-choice-title', item.title);
                    if (item.notePath) el(row, 'span', 'hg-project-choice-path', item.notePath);
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) selectedProjectRefs.set(item.key, {
                            key: item.key,
                            title: item.title,
                            notePath: item.notePath || '',
                            rawValue: item.rawValue || item.title
                        });
                        else selectedProjectRefs.delete(item.key);
                        syncSummary();
                    });
                }
                if (!candidates.size) el(list, 'div', 'hg-project-choice-empty', '尚未关联项目笔记');
                syncSummary();
            };
            const addProjectNoteBtn = el(panel, 'button', 'hg-button hg-project-note-picker', '＋ 选择其他笔记');
            addProjectNoteBtn.type = 'button';
            addProjectNoteBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                new ProjectNotePickerModal(this.app, (file) => {
                    if (!(file instanceof TFile)) return;
                    const ref = this.projectRefFromFile(file, task.file);
                    if (ref) selectedProjectRefs.set(ref.key, ref);
                    renderChoices();
                }).open();
            });
            summary.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                panel.hidden = !panel.hidden;
                summary.toggleClass('is-expanded', !panel.hidden);
                summary.setAttribute('aria-expanded', String(!panel.hidden));
                this.placePopover(pop, anchor);
            });
            summary.setAttribute('aria-expanded', 'false');
            renderChoices();
        } else {
            projectInput = this.makeField(pop, '所属项目（project 属性）', el(document.body, 'select', 'hg-input'));
            for (const p of this.board.projects) {
                const option = el(projectInput, 'option', '', p.title);
                option.value = p.title;
            }
            projectInput.value = task.project || project.title;
        }
        const statusInput = this.makeField(pop, isTaskNotes ? '任务状态' : '看板状态 / 分栏', el(document.body, 'select', 'hg-input'));
        for (const col of this.board.columns) {
            const option = el(statusInput, 'option', '', col.heading);
            option.value = col.heading;
        }
        statusInput.value = task.status;
        let priorityInput = null;
        if (isTaskNotes) {
            priorityInput = this.makeField(pop, '优先级（priority）', el(document.body, 'select', 'hg-input'));
            const priorityOptions = this.taskNotesPriorityOptions(task.priority);
            for (const item of priorityOptions) {
                const option = el(priorityInput, 'option', '', item.label);
                option.value = item.value;
            }
            const currentPriority = String(task.priority || '').trim();
            priorityInput.value = priorityOptions.some((item) => item.value === currentPriority)
                ? currentPriority
                : (priorityOptions.find((item) => item.value === 'none')?.value || priorityOptions[0]?.value || '');
        }
        const dates = el(pop, 'div', 'hg-field-grid');
        const startInput = el(document.body, 'input', 'hg-input hg-date-no-overlap');
        startInput.type = 'date';
        startInput.value = isTaskNotes ? (task.scheduledDate || '') : task.start;
        const endInput = el(document.body, 'input', 'hg-input hg-date-no-overlap');
        endInput.type = 'date';
        endInput.value = isTaskNotes ? (task.dueDate || '') : task.end;
        const startField = el(dates, 'label', 'hg-field');
        el(startField, 'span', '', isTaskNotes ? '计划开始（scheduled）' : '开始');
        startField.appendChild(startInput);
        const endField = el(dates, 'label', 'hg-field');
        el(endField, 'span', '', isTaskNotes ? '截止日期（due）' : '结束');
        endField.appendChild(endInput);
        let estimateInput = null;
        if (isTaskNotes) {
            estimateInput = this.makeField(pop, '预计耗时（timeEstimate，分钟）', el(document.body, 'input', 'hg-input'));
            estimateInput.type = 'number';
            estimateInput.min = '0';
            estimateInput.step = '15';
            estimateInput.value = task.timeEstimate ? String(task.timeEstimate) : '';
            el(pop, 'div', 'hg-task-project-hint', '与 TaskNotes 日历一致：甘特条代表 scheduled + timeEstimate；截止菱形代表 due。拖动条只改 scheduled，拖动右端只改 timeEstimate。');
        }
        const doneWrap = el(pop, 'label', 'hg-check-field');
        const doneInput = el(doneWrap, 'input', '');
        doneInput.type = 'checkbox';
        doneInput.checked = task.done;
        el(doneWrap, 'span', '', '已完成');
        statusInput.addEventListener('change', () => {
            doneInput.checked = this.isCompletedStatusValue(statusInput.value);
        });
        doneInput.addEventListener('change', () => {
            if (doneInput.checked) statusInput.value = this.tnCompleted || 'done';
            else if (this.isCompletedStatusValue(statusInput.value)) statusInput.value = this.tnOpen || this.defaultStatus();
        });
        const notesInput = this.makeField(pop, isTaskNotes ? '备注 / 笔记正文' : '备注 / 卡片描述', el(document.body, 'textarea', 'hg-input hg-textarea'));
        notesInput.rows = 4;
        notesInput.value = task.notes || '';
        const footer = el(pop, 'div', 'hg-popover-actions');
        const openBtn = el(footer, 'button', 'hg-button', isTaskNotes ? '打开任务笔记' : (task.linkTarget ? '打开详情页' : '创建详情页'));
        const deleteBtn = el(footer, 'button', 'hg-button hg-danger', '删除任务');
        const saveBtn = el(footer, 'button', 'hg-button hg-primary', '保存');
        const save = async (ensureFile = true) => {
            const commonPatch = {
                title: titleInput.value.trim() || '未命名任务',
                status: statusInput.value,
                done: doneInput.checked,
                notes: notesInput.value.trim(),
                ensureFile
            };
            if (isTaskNotes) return await this.updateTask(task, {
                ...commonPatch,
                projects: [...selectedProjectRefs.values()].map((ref) => this.projectValueForTask(ref, task.file)).filter(Boolean),
                priority: priorityInput?.value || '',
                scheduled: startInput.value || '',
                due: endInput.value || '',
                timeEstimate: estimateInput?.value ? Number(estimateInput.value) : null
            });
            const start = startInput.value || toYmd(new Date());
            const end = endInput.value || start;
            return await this.updateTask(task, {
                ...commonPatch,
                project: projectInput.value,
                start,
                end: parseDate(end) < parseDate(start) ? start : end
            });
        };
        saveBtn.addEventListener('click', () => this.withPageScrollPreserved(() => save(true)));
        openBtn.addEventListener('click', async () => {
            await save(true);
            await this.openTaskDetail({
                ...task,
                title: titleInput.value.trim() || task.title,
                project: isTaskNotes ? ([...selectedProjectRefs.values()][0]?.title || UNASSIGNED_PROJECT) : projectInput.value
            });
        });
        deleteBtn.addEventListener('click', async () => {
            await this.withPageScrollPreserved(() => this.deleteTask(task));
        });
        this.placePopover(pop, anchor);
        this.restorePageScroll(popoverScrollSnapshot);
    }
    scrollToToday() {
        if (!this.timelinePane) return;
        const range = this.computeRange(),
            cellWidth = this.displayCellWidth();
        const todayIndex = diffDays(range.start, startOfDay(new Date()));
        if (todayIndex >= 0) this.timelinePane.scrollLeft = Math.max(0, todayIndex * cellWidth - this.timelinePane.clientWidth / 2);
    }
}

module.exports = CarrotGanttPlugin;
