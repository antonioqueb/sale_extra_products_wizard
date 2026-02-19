/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { useEnv } from "@odoo/owl";
import { mount } from "@odoo/owl";

// ============================================================
// Toast helper
// ============================================================
function showToast(message, type = "success", duration = 3000) {
    const existing = document.querySelector(".o_ep_toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `o_ep_toast ${type}`;
    toast.innerHTML = `<span>${type === "success" ? "✓" : "ℹ"}</span> <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = "opacity 0.4s";
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 400);
    }, duration);
}

// ============================================================
// Wizard mount/unmount
// ============================================================
let _wizardApp = null;
let _wizardContainer = null;

function closeWizard() {
    if (_wizardApp) {
        try { _wizardApp.destroy(); } catch (e) {}
        _wizardApp = null;
    }
    if (_wizardContainer) {
        _wizardContainer.remove();
        _wizardContainer = null;
    }
}

async function openWizard(env, products, callbacks) {
    closeWizard();
    const container = document.createElement("div");
    document.body.appendChild(container);
    _wizardContainer = container;
    _wizardApp = await mount(ExtraProductsDialog, container, {
        env,
        props: {
            products,
            onConfirm: (data) => { closeWizard(); callbacks.onConfirm(data); },
            onSkip:    ()     => { closeWizard(); callbacks.onSkip(); },
            onDismiss: ()     => { closeWizard(); callbacks.onDismiss(); },
        },
    });
}

// ============================================================
// Órdenes ya procesadas (no volver a preguntar en esta sesión)
// ============================================================
const _processed = new Set();

// ============================================================
// Lógica central
// ============================================================
async function handleWizard({ orm, env, recordId, triggerType, reloadCallback }) {
    if (!recordId || _processed.has(recordId)) return true;

    let config;
    try {
        config = await orm.call("sale.order", "get_extra_products_config", [[recordId]]);
        if (Array.isArray(config)) config = config[0];
    } catch (e) {
        console.error("[ExtraWizard] config error:", e);
        return true;
    }

    if (!config || !config.enabled) return true;
    if (config.has_extra_products || config.extra_products_dismissed) {
        _processed.add(recordId);
        return true;
    }

    const trigger = triggerType === "confirm" ? config.trigger_confirm : config.trigger_print;
    if (!trigger) return true;

    let products;
    try {
        products = await orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
    } catch (e) {
        console.error("[ExtraWizard] products error:", e);
        return true;
    }

    if (!products || products.length === 0) return true;

    return new Promise((resolve) => {
        openWizard(env, products, {
            onConfirm: async (productsData) => {
                try {
                    await orm.call("sale.order", "action_add_extra_products", [[recordId], productsData]);
                    _processed.add(recordId);
                    showToast(`${productsData.length} producto(s) adicional(es) agregado(s)`, "success");
                    await reloadCallback();
                } catch (e) {
                    console.error("[ExtraWizard] add error:", e);
                }
                resolve(true);
            },
            onSkip: async () => {
                try {
                    await orm.call("sale.order", "action_dismiss_extra_products_wizard", [[recordId]]);
                    _processed.add(recordId);
                } catch (e) {}
                showToast("Continuando sin adicionales", "info", 2000);
                resolve(true);
            },
            onDismiss: () => {
                // Cierra sin acción → no continuar con el botón original
                resolve(false);
            },
        });
    });
}

// ============================================================
// PATCH al FormController - usando beforeExecuteActionButton
// Este es el hook oficial de Odoo 19 que se llama antes de
// ejecutar cualquier botón de acción en el formulario.
// Retornar false cancela la ejecución del botón.
// ============================================================
patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm = useService("orm");
        this._epEnv = useEnv();
    },

    async beforeExecuteActionButton(clickParams) {
        const model = this.model?.root?.resModel;
        if (model !== "sale.order") {
            return super.beforeExecuteActionButton?.(clickParams);
        }

        const recordId = this.model?.root?.resId;
        if (!recordId) return super.beforeExecuteActionButton?.(clickParams);

        const name   = (clickParams?.name   || "").toLowerCase();
        const type   = (clickParams?.type   || "").toLowerCase();
        const string = (clickParams?.string || "").toLowerCase();

        const isConfirm = name === "action_confirm";
        const isPrint = (
            type === "ir.actions.report" ||
            name.includes("print") ||
            name.includes("report") ||
            string.includes("imprimir") ||
            string.includes("print") ||
            string.includes("enviar") ||
            string.includes("send")
        );

        if (!isConfirm && !isPrint) {
            return super.beforeExecuteActionButton?.(clickParams);
        }

        const triggerType = isConfirm ? "confirm" : "print";

        const shouldContinue = await handleWizard({
            orm: this._epOrm,
            env: this._epEnv,
            recordId,
            triggerType,
            reloadCallback: async () => {
                await this.model.root.load();
                this.render(true);
            },
        });

        if (!shouldContinue) return false;

        return super.beforeExecuteActionButton?.(clickParams);
    },
});