/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { App, useEnv } from "@odoo/owl";

// ─── Gestión del wizard montado ───────────────────────────────────────────────
let _currentApp = null;
let _currentContainer = null;

function destroyWizard() {
    if (_currentApp) {
        try { _currentApp.destroy(); } catch (_) {}
        _currentApp = null;
    }
    if (_currentContainer) {
        try { _currentContainer.remove(); } catch (_) {}
        _currentContainer = null;
    }
}

async function openWizard(env, products) {
    destroyWizard();

    return new Promise((resolve) => {
        const container = document.createElement("div");
        container.id = "o_extra_products_wizard_root";
        document.body.appendChild(container);
        _currentContainer = container;

        const app = new App(ExtraProductsDialog, {
            env,
            props: {
                products,
                onConfirm: (data) => { destroyWizard(); resolve({ action: "confirm", data }); },
                onSkip:    ()     => { destroyWizard(); resolve({ action: "skip" }); },
                onDismiss: ()     => { destroyWizard(); resolve({ action: "dismiss" }); },
            },
        });

        _currentApp = app;
        app.mount(container).catch((err) => {
            console.error("[ExtraWizard] mount error:", err);
            destroyWizard();
            resolve({ action: "skip" });
        });
    });
}

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

// ─── Lógica central ───────────────────────────────────────────────────────────
async function runExtraProductsWizard({ orm, env, recordId, triggerType, reloadFn }) {
    if (_processedOrders.has(recordId)) return true;

    let config;
    try {
        const result = await orm.call("sale.order", "get_extra_products_config", [[recordId]]);
        config = Array.isArray(result) ? result[0] : result;
    } catch (e) {
        console.error("[ExtraWizard] Error config:", e);
        return true;
    }

    if (!config || !config.enabled) return true;
    if (config.has_extra_products || config.extra_products_dismissed) {
        _processedOrders.add(recordId);
        return true;
    }

    const shouldTrigger = triggerType === "confirm" ? config.trigger_confirm : config.trigger_print;
    if (!shouldTrigger) return true;

    // Solo en borrador o enviado
    if (!["draft", "sent"].includes(config.order_state)) {
        _processedOrders.add(recordId);
        return true;
    }

    let products;
    try {
        products = await orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
    } catch (e) {
        console.error("[ExtraWizard] Error productos:", e);
        return true;
    }

    if (!products || products.length === 0) {
        _processedOrders.add(recordId);
        return true;
    }

    const result = await openWizard(env, products);

    if (result.action === "confirm") {
        try {
            await orm.call("sale.order", "action_add_extra_products", [[recordId], result.data]);
            _processedOrders.add(recordId);
            await reloadFn();
            showToast(`${result.data.length} producto(s) adicional(es) agregado(s) ✨`, "success", 3500);
        } catch (e) {
            console.error("[ExtraWizard] Error al agregar:", e);
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
        return false;
    }
}

// ─── PATCH FormController ─────────────────────────────────────────────────────
patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm = useService("orm");
        this._epEnv = useEnv();
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
            env: this._epEnv,
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