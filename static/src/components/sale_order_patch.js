/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { useEnv } from "@odoo/owl";
import { actionService } from "@web/core/action_manager/action_service";

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

// ─── Referencia al dialog service (se asigna desde el FormController) ────────
let _dialogService = null;
let _ormService = null;

// ─── Abrir wizard ─────────────────────────────────────────────────────────────
function openWizard(products) {
    if (!_dialogService) return Promise.resolve({ action: "skip" });
    LOG("openWizard() con", products.length, "productos");

    return new Promise((resolve) => {
        let _resolved = false;
        const safeResolve = (value) => {
            if (!_resolved) { _resolved = true; resolve(value); }
        };
        _dialogService.add(
            ExtraProductsDialog,
            {
                products,
                onConfirm: (data) => { LOG("onConfirm", data.length); safeResolve({ action: "confirm", data }); },
                onSkip:    ()     => { LOG("onSkip");                  safeResolve({ action: "skip" }); },
            },
            {
                onClose: () => { LOG("onClose"); safeResolve({ action: "dismiss" }); },
            }
        );
    });
}

// ─── Detectar acción de impresión/reporte ────────────────────────────────────
function isReportAction(action) {
    if (!action) return false;

    const type = (
        action.type ||
        action?.action?.type ||
        ""
    ).toString().toLowerCase();

    const name = (
        action.name ||
        action?.action?.name ||
        action.xml_id ||
        ""
    ).toString().toLowerCase();

    const tag = (action.tag || action?.action?.tag || "").toString().toLowerCase();

    // Tipo nativo de reporte de Odoo
    if (type === "ir.actions.report") return true;

    // Tag del cliente web para reportes
    if (tag === "action_report") return true;

    // Nombres que incluyen patrones de reporte de sale.order
    if (
        name.includes("report") ||
        name.includes("saleorder") ||
        name.includes("sale_order") ||
        name.includes("quotation") ||
        name.includes("proforma")
    ) return true;

    return false;
}

// ─── Obtener el recordId activo desde el controlador activo ──────────────────
function getActiveSaleOrderId() {
    // Buscar en el DOM el componente OWL activo de tipo FormController en sale.order
    try {
        const formView = document.querySelector(".o_form_view");
        if (!formView) return null;

        // Recorrer el árbol OWL buscando el FormController de sale.order
        let node = formView.__owl__;
        while (node) {
            const comp = node.component;
            if (comp && comp.model?.root?.resModel === "sale.order") {
                return comp.model?.root?.resId || null;
            }
            node = node.parent;
        }
    } catch (_) {}
    return null;
}

// ─── Lógica central ───────────────────────────────────────────────────────────
async function runExtraProductsWizard({ recordId, triggerType, reloadFn }) {
    LOG("START | recordId:", recordId, "| trigger:", triggerType);

    if (!recordId || _processedOrders.has(recordId)) {
        LOG("⏭ Sin recordId o ya procesado");
        return true;
    }

    if (!_ormService) {
        LOG("⚠ ORM service no disponible");
        return true;
    }

    let config;
    try {
        const result = await _ormService.call("sale.order", "get_extra_products_config", [[recordId]]);
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

    const shouldTrigger = triggerType === "confirm" ? config.trigger_confirm : config.trigger_print;
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
        products = await _ormService.call("sale.order", "get_suggested_extra_products", [[recordId]]);
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
    const result = await openWizard(products);
    LOG("Resultado:", result.action);

    if (result.action === "confirm") {
        try {
            await _ormService.call("sale.order", "action_add_extra_products", [[recordId], result.data]);
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
            await _ormService.call("sale.order", "action_dismiss_extra_products_wizard", [[recordId]]);
            _processedOrders.add(recordId);
        } catch (_) {}
        showToast("Continuando sin productos adicionales", "info", 2000);
        return true;

    } else {
        LOG("dismiss → cancelando");
        return false;
    }
}

// ─── PATCH al actionService — intercepta TODOS los doAction del sistema ───────
patch(actionService, {
    async start(env, services) {
        const result = await super.start(env, services);

        // Guardar referencia al orm desde el env
        _ormService = services.orm;

        const originalDoAction = result.doAction.bind(result);

        result.doAction = async function(action, options) {
            LOG("actionService.doAction interceptado:", JSON.stringify(action).substring(0, 150));

            if (isReportAction(action)) {
                // Obtener el recordId del formulario activo
                const recordId = getActiveSaleOrderId();
                LOG("Es reporte | recordId desde DOM:", recordId);

                if (recordId) {
                    const shouldContinue = await runExtraProductsWizard({
                        recordId,
                        triggerType: "print",
                        reloadFn: null, // No recargar al imprimir, solo agregar
                    });

                    if (!shouldContinue) {
                        LOG("Acción de reporte cancelada por dismiss");
                        return;
                    }
                }
            }

            return originalDoAction(action, options);
        };

        return result;
    }
});

// ─── PATCH FormController — captura servicios y botón Confirmar ───────────────
LOG("🔌 Registrando patch FormController...");

patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm    = useService("orm");
        this._epDialog = useService("dialog");
        this._epEnv    = useEnv();

        // Exponer servicios globalmente para el patch del actionService
        _dialogService = this._epDialog;
        _ormService    = this._epOrm;

        LOG("FormController.setup() — servicios capturados");
    },

    async beforeExecuteActionButton(clickParams) {
        const resModel = this.model?.root?.resModel;
        if (resModel !== "sale.order") {
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const recordId = this.model?.root?.resId;
        if (!recordId) return super.beforeExecuteActionButton?.(clickParams) ?? true;

        const btnName   = (clickParams?.name   || "").toLowerCase();
        const btnString = (clickParams?.string || "").toLowerCase();
        const btnType   = (clickParams?.type   || "").toLowerCase();

        LOG("beforeExecuteActionButton | name:", btnName, "| type:", btnType, "| string:", btnString);

        const isConfirm = btnName === "action_confirm";

        // Para imprimir desde botón directo del header
        const isPrint = isReportAction(clickParams) || (
            btnType === "action" && (
                btnName.includes("report") ||
                btnName.includes("saleorder") ||
                btnName.includes("print") ||
                btnName.includes("preview")
            )
        ) || btnString.includes("imprimir") || btnString.includes("enviar");

        if (!isConfirm && !isPrint) {
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const triggerType = isConfirm ? "confirm" : "print";

        const shouldContinue = await runExtraProductsWizard({
            recordId,
            triggerType,
            reloadFn: async () => {
                await this.model.root.load();
                this.render(true);
            },
        });

        if (!shouldContinue) return false;
        return super.beforeExecuteActionButton?.(clickParams) ?? true;
    },
});

LOG("✅ Patch registrado.");