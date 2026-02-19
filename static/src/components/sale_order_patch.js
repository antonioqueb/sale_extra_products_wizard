/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { useEnv, onMounted, onWillUnmount } from "@odoo/owl";
import { ActionMenus } from "@web/search/action_menus/action_menus";

const LOG = (...args) => console.log("%c[ExtraWizard]", "color:#0f3460;font-weight:bold", ...args);
const ERR = (...args) => console.error("%c[ExtraWizard ERROR]", "color:red;font-weight:bold", ...args);

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = "success", duration = 3000) {
    const existing = document.querySelector(".o_ep_toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `o_ep_toast ${type}`;
    toast.innerHTML = `<span class="o_ep_toast_icon">${type === "success" ? "✓" : "ℹ"}</span><span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = "opacity 0.4s, transform 0.4s";
        toast.style.opacity = "0";
        toast.style.transform = "translateY(16px)";
        setTimeout(() => toast.remove(), 400);
    }, duration);
}

// ─── Órdenes ya procesadas en esta sesión ────────────────────────────────────
const _processedOrders = new Set();

// ─── Abrir wizard via dialog service ─────────────────────────────────────────
function openWizard(dialogService, products) {
    LOG("openWizard() con", products.length, "productos");
    return new Promise((resolve) => {
        let _resolved = false;
        const safeResolve = (value) => {
            if (!_resolved) {
                _resolved = true;
                LOG("safeResolve:", value.action);
                resolve(value);
            }
        };
        dialogService.add(
            ExtraProductsDialog,
            {
                products,
                onConfirm: (data) => safeResolve({ action: "confirm", data }),
                onSkip:    ()     => safeResolve({ action: "skip" }),
                onDismiss: ()     => safeResolve({ action: "dismiss" }),
            },
            {
                onClose: () => safeResolve({ action: "dismiss" }),
            }
        );
    });
}

// ─── Detectar si un action es de tipo impresión/reporte ──────────────────────
function isPrintAction(params) {
    if (!params) return false;
    const name   = (params?.name   || params?.action?.name   || "").toString().toLowerCase();
    const type   = (params?.type   || params?.action?.type   || "").toString().toLowerCase();
    const tag    = (params?.tag    || params?.action?.tag    || "").toString().toLowerCase();
    const string = (params?.string || "").toString().toLowerCase();

    if (type === "ir.actions.report") return true;
    if (tag === "action_report") return true;
    if (type === "action" && (
        name.includes("report") ||
        name.includes("print") ||
        name.includes("preview") ||
        name.includes("saleorder") ||
        name.includes("sale_order")
    )) return true;
    if (
        string.includes("imprimir") ||
        string.includes("print") ||
        string.includes("enviar") ||
        string.includes("send") ||
        string.includes("email") ||
        string.includes("correo")
    ) return true;

    return false;
}

// ─── Lógica central ───────────────────────────────────────────────────────────
async function runExtraProductsWizard({ orm, dialogService, recordId, triggerType, reloadFn }) {
    LOG("START | recordId:", recordId, "| trigger:", triggerType);

    if (_processedOrders.has(recordId)) {
        LOG("⏭ Ya procesado en esta sesión");
        return true;
    }

    let config;
    try {
        const result = await orm.call("sale.order", "get_extra_products_config", [[recordId]]);
        config = Array.isArray(result) ? result[0] : result;
        LOG("Config:", JSON.stringify(config, null, 2));
    } catch (e) {
        ERR("get_extra_products_config falló:", e);
        return true;
    }

    if (!config || !config.enabled) { LOG("⏭ Desactivado"); return true; }
    if (config.has_extra_products || config.extra_products_dismissed) {
        LOG("⏭ Ya tiene adicionales o descartado");
        _processedOrders.add(recordId);
        return true;
    }

    const shouldTrigger = triggerType === "confirm"
        ? config.trigger_confirm
        : triggerType === "print"
            ? config.trigger_print
            : config.enabled; // "idle" siempre pasa si está habilitado

    if (!shouldTrigger) { LOG("⏭ Trigger inactivo:", triggerType); return true; }

    if (!["draft", "sent"].includes(config.order_state)) {
        LOG("⏭ Estado no aplica:", config.order_state);
        _processedOrders.add(recordId);
        return true;
    }

    if (!config.category_ids || config.category_ids.length === 0) {
        LOG("⚠ Sin categorías configuradas");
        _processedOrders.add(recordId);
        return true;
    }

    let products;
    try {
        products = await orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
        LOG("Productos:", products?.length);
    } catch (e) {
        ERR("get_suggested_extra_products falló:", e);
        return true;
    }

    if (!products || products.length === 0) {
        LOG("⚠ Sin productos en las categorías");
        _processedOrders.add(recordId);
        return true;
    }

    LOG("Abriendo wizard...");
    const result = await openWizard(dialogService, products);
    LOG("Resultado:", result.action);

    if (result.action === "confirm") {
        try {
            await orm.call("sale.order", "action_add_extra_products", [[recordId], result.data]);
            _processedOrders.add(recordId);
            if (reloadFn) await reloadFn();
            showToast(`${result.data.length} producto(s) adicional(es) agregado(s) ✨`, "success", 3500);
            LOG("✅ OK");
        } catch (e) {
            ERR("action_add_extra_products falló:", e);
        }
        return true;

    } else if (result.action === "skip") {
        try {
            await orm.call("sale.order", "action_dismiss_extra_products_wizard", [[recordId]]);
            _processedOrders.add(recordId);
        } catch (_) {}
        showToast("Continuando sin productos adicionales", "info", 2000);
        return true;

    } else {
        // dismiss = X o Escape
        LOG("dismiss");
        return false;
    }
}

// ─── PATCH FormController ─────────────────────────────────────────────────────
const IDLE_TIMEOUT_MS = 15000; // 10 segundos sin actividad

LOG("🔌 Registrando patch FormController...");

patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm    = useService("orm");
        this._epDialog = useService("dialog");
        this._epEnv    = useEnv();

        // ── Timer de inactividad ──────────────────────────────────────────────
        this._epIdleTimer    = null;
        this._epIdleRunning  = false; // true mientras el wizard de inactividad está abierto

        // Arrancar el timer de inactividad solo en sale.order
        onMounted(() => {
            if (this.model?.root?.resModel === "sale.order") {
                LOG("FormController montado en sale.order — iniciando idle timer");
                this._epResetIdleTimer();

                // Cualquier input/click/keydown reinicia el timer
                this._epActivityHandler = () => this._epResetIdleTimer();
                document.addEventListener("mousemove",  this._epActivityHandler, { passive: true });
                document.addEventListener("keydown",    this._epActivityHandler, { passive: true });
                document.addEventListener("mousedown",  this._epActivityHandler, { passive: true });
                document.addEventListener("touchstart", this._epActivityHandler, { passive: true });
            }
        });

        onWillUnmount(() => {
            this._epClearIdleTimer();
            if (this._epActivityHandler) {
                document.removeEventListener("mousemove",  this._epActivityHandler);
                document.removeEventListener("keydown",    this._epActivityHandler);
                document.removeEventListener("mousedown",  this._epActivityHandler);
                document.removeEventListener("touchstart", this._epActivityHandler);
            }
        });

        LOG("FormController.setup() activo");
    },

    _epClearIdleTimer() {
        if (this._epIdleTimer) {
            clearTimeout(this._epIdleTimer);
            this._epIdleTimer = null;
        }
    },

    _epResetIdleTimer() {
        // No reiniciar si el wizard ya está abierto
        if (this._epIdleRunning) return;

        this._epClearIdleTimer();

        const resModel  = this.model?.root?.resModel;
        const recordId  = this.model?.root?.resId;

        if (resModel !== "sale.order" || !recordId) return;

        this._epIdleTimer = setTimeout(async () => {
            LOG("⏱ Inactividad detectada — abriendo wizard | recordId:", recordId);

            // Verificar que el registro sigue siendo el mismo y no está procesado
            const currentRecordId = this.model?.root?.resId;
            if (currentRecordId !== recordId) return;
            if (_processedOrders.has(recordId)) return;

            this._epIdleRunning = true;
            this._epClearIdleTimer();

            await runExtraProductsWizard({
                orm:           this._epOrm,
                dialogService: this._epDialog,
                recordId,
                triggerType:   "idle",
                reloadFn: async () => {
                    await this.model.root.load();
                    this.render(true);
                },
            });

            this._epIdleRunning = false;
            // Reiniciar el timer después de que el wizard se cierre
            this._epResetIdleTimer();

        }, IDLE_TIMEOUT_MS);
    },

    // ── Intercepta botones normales del header (Confirmar, Imprimir directo) ──
    async beforeExecuteActionButton(clickParams) {
        const resModel = this.model?.root?.resModel;
        if (resModel !== "sale.order") {
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const recordId = this.model?.root?.resId;
        if (!recordId) return super.beforeExecuteActionButton?.(clickParams) ?? true;

        const btnName   = (clickParams?.name   || "").toLowerCase();
        const btnString = (clickParams?.string || "").toLowerCase();

        LOG("beforeExecuteActionButton | name:", btnName, "| type:", clickParams?.type, "| string:", btnString);

        const isConfirm = btnName === "action_confirm";
        const isPrint   = isPrintAction({ ...clickParams, string: btnString });

        if (!isConfirm && !isPrint) {
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        // Parar el idle timer mientras se ejecuta una acción manual
        this._epClearIdleTimer();

        const triggerType = isConfirm ? "confirm" : "print";

        const shouldContinue = await runExtraProductsWizard({
            orm:           this._epOrm,
            dialogService: this._epDialog,
            recordId,
            triggerType,
            reloadFn: async () => {
                await this.model.root.load();
                this.render(true);
            },
        });

        // Reanudar el timer
        this._epResetIdleTimer();

        if (!shouldContinue) return false;
        return super.beforeExecuteActionButton?.(clickParams) ?? true;
    },
});

// ─── PATCH ActionMenus — intercepta el engrane ───────────────────────────────
LOG("🔌 Registrando patch ActionMenus...");

patch(ActionMenus.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm    = useService("orm");
        this._epDialog = useService("dialog");
        LOG("ActionMenus.setup() — patch activo");
    },

    async executeAction(action) {
        LOG("ActionMenus.executeAction | action:", JSON.stringify(action).substring(0, 200));

        const resModel = this.props?.context?.active_model || "";

        if (resModel !== "sale.order") {
            return super.executeAction(action);
        }

        if (!isPrintAction(action)) {
            return super.executeAction(action);
        }

        const activeId  = this.props?.context?.active_id;
        const activeIds = this.props?.context?.active_ids;
        const recordId  = activeId || (activeIds && activeIds[0]);

        LOG("ActionMenus: reporte detectado | recordId:", recordId);

        if (!recordId) {
            return super.executeAction(action);
        }

        const shouldContinue = await runExtraProductsWizard({
            orm:           this._epOrm,
            dialogService: this._epDialog,
            recordId,
            triggerType:   "print",
            reloadFn:      null,
        });

        if (!shouldContinue) {
            LOG("ActionMenus: acción cancelada");
            return;
        }

        return super.executeAction(action);
    },
});

LOG("✅ Patches registrados.");