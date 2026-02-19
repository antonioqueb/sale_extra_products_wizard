/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { mount, destroy } from "@odoo/owl";

// ------------------------------------------------------------------ //
// Helper: mostrar toast
// ------------------------------------------------------------------ //
function showToast(message, type = "success", duration = 3500) {
    const toast = document.createElement("div");
    toast.className = `o_ep_toast ${type}`;
    toast.innerHTML = `<span>${type === "success" ? "✓" : "ℹ"}</span> ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = "opacity 0.4s";
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 400);
    }, duration);
}

// ------------------------------------------------------------------ //
// Helper: montar/desmontar el wizard OWL en un portal DOM
// ------------------------------------------------------------------ //
let _activeWizardContainer = null;

async function openExtraProductsWizard({ products, onConfirm, onSkip, onDismiss }) {
    // Limpiar si hay uno abierto
    if (_activeWizardContainer) {
        _activeWizardContainer.remove();
        _activeWizardContainer = null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    _activeWizardContainer = container;

    await mount(ExtraProductsDialog, container, {
        props: {
            products,
            onConfirm: (data) => {
                closeWizard();
                onConfirm(data);
            },
            onSkip: () => {
                closeWizard();
                onSkip();
            },
            onDismiss: () => {
                closeWizard();
                onDismiss();
            },
        },
        env: owl.__info__.env || {},
    });

    function closeWizard() {
        if (_activeWizardContainer) {
            _activeWizardContainer.remove();
            _activeWizardContainer = null;
        }
    }
}

// ------------------------------------------------------------------ //
// Estado por sesión: evitar doble disparo
// ------------------------------------------------------------------ //
const _wizardShownForOrders = new Set();

// ------------------------------------------------------------------ //
// Lógica principal
// ------------------------------------------------------------------ //

/**
 * Determina si el wizard debe mostrarse para esta orden.
 * Retorna { shouldShow, products } 
 */
async function checkAndGetWizardData(orm, recordId) {
    if (!recordId) return { shouldShow: false };
    if (_wizardShownForOrders.has(recordId)) return { shouldShow: false };

    const [config] = await orm.call("sale.order", "get_extra_products_config", [[recordId]]);
    
    if (!config.enabled) return { shouldShow: false };
    // Si ya tiene productos adicionales o fue descartado, no mostrar
    if (config.has_extra_products || config.extra_products_dismissed) return { shouldShow: false };

    const products = await orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
    if (!products || products.length === 0) return { shouldShow: false };

    return { shouldShow: true, config, products };
}

// ------------------------------------------------------------------ //
// Patch al FormController - interceptar botones críticos
// ------------------------------------------------------------------ //

patch(FormController.prototype, {

    setup() {
        super.setup(...arguments);
        this._orm = useService("orm");
        this._notification = useService("notification");
        // referencia para saber si estamos en sale.order
        this._extraWizardPending = null;
    },

    /**
     * Muestra el wizard y retorna una Promise que resuelve true/false
     * true  = continuar con la acción original
     * false = cancelar la acción (el wizard fue dismiss sin agregar)
     */
    async _showExtraWizardIfNeeded(triggerType) {
        const model = this.model?.root?.resModel || this.props?.resModel;
        if (model !== "sale.order") return true;

        const recordId = this.model?.root?.resId;
        if (!recordId) return true;

        // Obtener config del trigger
        const [config] = await this._orm.call("sale.order", "get_extra_products_config", [[recordId]]);
        if (!config.enabled) return true;
        if (config.has_extra_products || config.extra_products_dismissed) return true;

        const checkTrigger = triggerType === "confirm"
            ? config.trigger_confirm
            : config.trigger_print;
        if (!checkTrigger) return true;

        const products = await this._orm.call("sale.order", "get_suggested_extra_products", [[recordId]]);
        if (!products || products.length === 0) return true;

        // Evitar doble apertura
        if (_wizardShownForOrders.has(recordId)) return true;
        _wizardShownForOrders.add(recordId);

        return new Promise((resolve) => {
            openExtraProductsWizard({
                products,
                onConfirm: async (productsData) => {
                    try {
                        await this._orm.call("sale.order", "action_add_extra_products", [[recordId], productsData]);
                        // Recargar el formulario para ver los productos agregados
                        await this.model.root.load();
                        this.render(true);
                        showToast(`✓ ${productsData.length} producto(s) adicional(es) agregado(s) a la orden`, "success");
                    } catch (e) {
                        console.error("Error al agregar productos adicionales:", e);
                    }
                    resolve(true);
                },
                onSkip: async () => {
                    // Marcar como descartado para esta orden (no volver a preguntar)
                    await this._orm.call("sale.order", "action_dismiss_extra_products_wizard", [[recordId]]);
                    showToast("Continuando sin productos adicionales", "info", 2000);
                    resolve(true);
                },
                onDismiss: async () => {
                    // Solo cierra el dialog, no marca como descartado permanente
                    // para que vuelva a preguntar en la próxima acción
                    _wizardShownForOrders.delete(recordId);
                    resolve(false);
                },
            });
        });
    },

    // Interceptar botón Confirmar (action_confirm)
    async actionConfirm() {
        const shouldContinue = await this._showExtraWizardIfNeeded("confirm");
        if (!shouldContinue) return;
        return super.actionConfirm?.(...arguments) ?? this._doAction("action_confirm");
    },

    // Interceptar acción de imprimir vía el método genérico executeAction / printReport
    async onActionButtonClick(clickParams) {
        // Detectar si es una acción de reporte/impresión
        const isReport = this._isPrintAction(clickParams);
        if (isReport) {
            const shouldContinue = await this._showExtraWizardIfNeeded("print");
            if (!shouldContinue) return;
        }
        return super.onActionButtonClick?.(clickParams);
    },

    _isPrintAction(params) {
        if (!params) return false;
        const name = (params.name || params.string || "").toLowerCase();
        const type = (params.type || "").toLowerCase();
        // Heurística: botones de impresión o reportes
        return (
            type === "ir.actions.report" ||
            name.includes("print") ||
            name.includes("imprimir") ||
            name.includes("report") ||
            name.includes("reporte") ||
            name.includes("pdf") ||
            name.includes("enviar") ||
            name.includes("send")
        );
    },

});

// ------------------------------------------------------------------ //
// Monkey-patch al ActionMenus para capturar "Imprimir" del menú Acción
// ------------------------------------------------------------------ //
import { ActionMenus } from "@web/search/action_menus/action_menus";

patch(ActionMenus.prototype, {
    async executeAction(action) {
        // Verificar si es SO y si es acción de reporte
        const formController = this.__owl__.parent;
        if (formController && formController._showExtraWizardIfNeeded) {
            const isPrint = formController._isPrintAction(action);
            if (isPrint) {
                const shouldContinue = await formController._showExtraWizardIfNeeded("print");
                if (!shouldContinue) return;
            }
        }
        return super.executeAction?.(action);
    },
});
