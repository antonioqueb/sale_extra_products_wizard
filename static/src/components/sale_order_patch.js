/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { useEnv } from "@odoo/owl";

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

// ─── Abrir wizard via dialog service (forma correcta en Odoo 19) ─────────────
function openWizard(dialogService, products) {
    LOG("openWizard() via dialog service con", products.length, "productos");

    return new Promise((resolve) => {
        let _resolved = false;

        const safeResolve = (value) => {
            if (!_resolved) {
                _resolved = true;
                resolve(value);
            }
        };

        dialogService.add(
            ExtraProductsDialog,
            {
                products,
                onConfirm: (data) => {
                    LOG("onConfirm llamado con", data);
                    safeResolve({ action: "confirm", data });
                },
                onSkip: () => {
                    LOG("onSkip llamado");
                    safeResolve({ action: "skip" });
                },
            },
            {
                // onClose se llama cuando el dialog se cierra (incluyendo X / Escape)
                // Si ya resolvió via confirm/skip, este dismiss no hace nada
                onClose: () => {
                    LOG("onClose del dialog service");
                    safeResolve({ action: "dismiss" });
                },
            }
        );
    });
}

// ─── Lógica central ───────────────────────────────────────────────────────────
async function runExtraProductsWizard({ orm, dialogService, recordId, triggerType, reloadFn }) {
    LOG("─── runExtraProductsWizard START ───");
    LOG("recordId:", recordId, "| triggerType:", triggerType);

    if (_processedOrders.has(recordId)) {
        LOG("⏭ Ya procesado en esta sesión, skip");
        return true;
    }

    // 1. Config
    LOG("1. Llamando get_extra_products_config...");
    let config;
    try {
        const result = await orm.call("sale.order", "get_extra_products_config", [[recordId]]);
        config = Array.isArray(result) ? result[0] : result;
        LOG("Config recibida:", JSON.stringify(config, null, 2));
    } catch (e) {
        ERR("get_extra_products_config falló:", e);
        return true;
    }

    if (!config || !config.enabled) {
        LOG("⏭ Config nula o módulo desactivado");
        return true;
    }
    if (config.has_extra_products || config.extra_products_dismissed) {
        LOG("⏭ Ya tiene adicionales o fue descartado");
        _processedOrders.add(recordId);
        return true;
    }

    const shouldTrigger = triggerType === "confirm" ? config.trigger_confirm : config.trigger_print;
    if (!shouldTrigger) {
        LOG("⏭ Trigger no activo para:", triggerType);
        return true;
    }

    if (!["draft", "sent"].includes(config.order_state)) {
        LOG("⏭ Estado no aplica:", config.order_state);
        _processedOrders.add(recordId);
        return true;
    }

    if (!config.category_ids || config.category_ids.length === 0) {
        LOG("⚠ Sin categorías configuradas en Ajustes > Ventas > Productos Adicionales");
        _processedOrders.add(recordId);
        return true;
    }

    // 2. Productos
    LOG("2. Llamando get_suggested_extra_products...");
    let products;
    try {
        products = await orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
        LOG("Productos recibidos:", products?.length, products);
    } catch (e) {
        ERR("get_suggested_extra_products falló:", e);
        return true;
    }

    if (!products || products.length === 0) {
        LOG("⚠ Sin productos en las categorías configuradas");
        _processedOrders.add(recordId);
        return true;
    }

    // 3. Abrir wizard
    LOG("3. Abriendo wizard...");
    const result = await openWizard(dialogService, products);
    LOG("Resultado del wizard:", result.action);

    if (result.action === "confirm") {
        try {
            await orm.call("sale.order", "action_add_extra_products", [[recordId], result.data]);
            _processedOrders.add(recordId);
            await reloadFn();
            showToast(`${result.data.length} producto(s) adicional(es) agregado(s) ✨`, "success", 3500);
            LOG("✅ Productos agregados OK");
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
        // dismiss → cancelar la acción original
        LOG("dismiss → cancelando acción original");
        return false;
    }
}

// ─── PATCH FormController ─────────────────────────────────────────────────────
LOG("🔌 Registrando patch en FormController...");

patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm = useService("orm");
        this._epDialog = useService("dialog");
        this._epEnv = useEnv();
        LOG("FormController.setup() — patch activo, dialog service:", !!this._epDialog);
    },

    async beforeExecuteActionButton(clickParams) {
        const resModel = this.model?.root?.resModel;
        if (resModel !== "sale.order") {
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const recordId = this.model?.root?.resId;
        if (!recordId) return super.beforeExecuteActionButton?.(clickParams) ?? true;

        const btnName   = (clickParams?.name   || "").toLowerCase();
        const btnType   = (clickParams?.type   || "").toLowerCase();
        const btnString = (clickParams?.string || "").toLowerCase();

        LOG("beforeExecuteActionButton | name:", btnName, "| type:", btnType, "| string:", btnString);

        const isConfirm = btnName === "action_confirm";
        const isPrint = (
            btnType === "ir.actions.report" ||
            btnName.includes("print") ||
            btnName.includes("report") ||
            btnName.includes("preview") ||
            btnString.includes("imprimir") ||
            btnString.includes("print") ||
            btnString.includes("enviar") ||
            btnString.includes("send") ||
            btnString.includes("email") ||
            btnString.includes("correo")
        );

        if (!isConfirm && !isPrint) {
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const triggerType = isConfirm ? "confirm" : "print";

        const shouldContinue = await runExtraProductsWizard({
            orm: this._epOrm,
            dialogService: this._epDialog,
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