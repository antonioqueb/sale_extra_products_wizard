/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { onMounted, onWillUnmount, useEnv } from "@odoo/owl";
import { mount } from "@odoo/owl";

// ============================================================
// Toast helper
// ============================================================
function showToast(message, type = "success", duration = 3500) {
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
// Montar wizard OWL en un contenedor DOM externo
// ============================================================
let _wizardContainer = null;
let _wizardApp = null;

async function openExtraProductsWizard(env, { products, onConfirm, onSkip, onDismiss }) {
    closeWizard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    _wizardContainer = container;

    _wizardApp = await mount(ExtraProductsDialog, container, {
        env,
        props: {
            products,
            onConfirm: (data) => { closeWizard(); onConfirm(data); },
            onSkip:    ()     => { closeWizard(); onSkip(); },
            onDismiss: ()     => { closeWizard(); onDismiss(); },
        },
    });
}

function closeWizard() {
    if (_wizardApp) {
        try { _wizardApp.destroy(); } catch(e) {}
        _wizardApp = null;
    }
    if (_wizardContainer) {
        _wizardContainer.remove();
        _wizardContainer = null;
    }
}

// ============================================================
// Control anti-doble-disparo por orden
// ============================================================
const _dismissedOrders = new Set();   // descartados permanente (skip)
const _shownThisSession = new Set();  // mostrados en esta carga de página

// ============================================================
// Función central: verificar y abrir wizard
// ============================================================
async function maybeShowWizard({ orm, env, recordId, triggerType, afterConfirm, afterSkip, afterDismiss }) {
    if (!recordId) { afterConfirm && afterConfirm(); return; }
    if (_dismissedOrders.has(recordId)) { afterConfirm && afterConfirm(); return; }

    let config;
    try {
        config = await orm.call("sale.order", "get_extra_products_config", [[recordId]]);
        // El método retorna un dict, no una lista
        if (Array.isArray(config)) config = config[0];
    } catch(e) {
        console.error("[ExtraWizard] Error obteniendo config:", e);
        afterConfirm && afterConfirm();
        return;
    }

    if (!config.enabled) { afterConfirm && afterConfirm(); return; }
    if (config.has_extra_products || config.extra_products_dismissed) {
        _dismissedOrders.add(recordId);
        afterConfirm && afterConfirm();
        return;
    }

    const trigger = triggerType === "confirm" ? config.trigger_confirm : config.trigger_print;
    if (!trigger) { afterConfirm && afterConfirm(); return; }

    // Evitar doble apertura simultánea
    if (_wizardContainer) return;

    let products;
    try {
        products = await orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
    } catch(e) {
        console.error("[ExtraWizard] Error obteniendo productos:", e);
        afterConfirm && afterConfirm();
        return;
    }

    if (!products || products.length === 0) {
        afterConfirm && afterConfirm();
        return;
    }

    await openExtraProductsWizard(env, {
        products,
        onConfirm: async (productsData) => {
            try {
                await orm.call("sale.order", "action_add_extra_products", [[recordId], productsData]);
                _dismissedOrders.add(recordId);
                showToast(`${productsData.length} producto(s) adicional(es) agregado(s)`, "success");
            } catch(e) {
                console.error("[ExtraWizard] Error agregando productos:", e);
            }
            afterConfirm && await afterConfirm();
        },
        onSkip: async () => {
            try {
                await orm.call("sale.order", "action_dismiss_extra_products_wizard", [[recordId]]);
                _dismissedOrders.add(recordId);
            } catch(e) {}
            showToast("Continuando sin adicionales", "info", 2000);
            afterConfirm && await afterConfirm();
        },
        onDismiss: () => {
            // No marca como descartado, solo cierra
            afterDismiss && afterDismiss();
        },
    });
}

// ============================================================
// PATCH al FormController
// ============================================================
patch(FormController.prototype, {
    setup() {
        super.setup(...arguments);
        this._epOrm = useService("orm");
        this._epEnv = useEnv();

        onMounted(() => {
            this._epInstallListeners();
        });

        onWillUnmount(() => {
            this._epRemoveListeners();
        });
    },

    _epGetRecordInfo() {
        const model = this.model?.root?.resModel || this.props?.resModel || "";
        const recordId = this.model?.root?.resId || null;
        return { model, recordId };
    },

    _epInstallListeners() {
        const { model } = this._epGetRecordInfo();
        if (model !== "sale.order") return;

        // Listener global en el root element del form
        const el = this.el || this.__owl__?.bdom?.el;
        if (!el) return;

        this._epClickHandler = async (ev) => {
            const btn = ev.target.closest("button[name], button[class]");
            if (!btn) return;

            const { model: m, recordId } = this._epGetRecordInfo();
            if (m !== "sale.order" || !recordId) return;

            const btnName = (btn.getAttribute("name") || "").toLowerCase();
            const btnClass = (btn.className || "").toLowerCase();
            const btnText = (btn.textContent || "").trim().toLowerCase();

            const isConfirm = btnName === "action_confirm" || btnText.includes("confirmar") || btnText.includes("confirm order");
            const isPrint = (
                btnName.includes("print") ||
                btnName.includes("report") ||
                btnText.includes("imprimir") ||
                btnText.includes("print") ||
                btnText.includes("enviar por correo") ||
                btnText.includes("send by email") ||
                btnClass.includes("o_print")
            );

            if (!isConfirm && !isPrint) return;

            // Prevenir la acción original
            ev.preventDefault();
            ev.stopImmediatePropagation();

            const triggerType = isConfirm ? "confirm" : "print";

            await maybeShowWizard({
                orm: this._epOrm,
                env: this._epEnv,
                recordId,
                triggerType,
                afterConfirm: async () => {
                    // Re-ejecutar la acción original después del wizard
                    await this.model.root.load();
                    this.__owl__?.render?.(true);
                    // Volver a disparar click en el botón original
                    btn.removeEventListener("click", this._epClickHandler, true);
                    btn.click();
                    // Re-instalar después de un tick
                    setTimeout(() => this._epInstallListeners(), 500);
                },
                afterDismiss: () => {
                    // No hacer nada, el usuario cerró el wizard
                },
            });
        };

        el.addEventListener("click", this._epClickHandler, true);
        this._epListenerEl = el;
    },

    _epRemoveListeners() {
        if (this._epListenerEl && this._epClickHandler) {
            this._epListenerEl.removeEventListener("click", this._epClickHandler, true);
        }
    },
});