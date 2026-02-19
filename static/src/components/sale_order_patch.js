/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { FormController } from "@web/views/form/form_controller";
import { ExtraProductsDialog } from "./extra_products_wizard";
import { useService } from "@web/core/utils/hooks";
import { App, useEnv } from "@odoo/owl";

const LOG = (...args) => console.log("%c[ExtraWizard]", "color:#0f3460;font-weight:bold", ...args);
const ERR = (...args) => console.error("%c[ExtraWizard ERROR]", "color:red;font-weight:bold", ...args);

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
    LOG("openWizard() llamado con", products.length, "productos");

    return new Promise((resolve) => {
        const container = document.createElement("div");
        container.id = "o_extra_products_wizard_root";
        document.body.appendChild(container);
        _currentContainer = container;
        LOG("Container montado en body:", container);

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
        LOG("App OWL creada, iniciando mount()...");

        app.mount(container)
            .then(() => {
                LOG("✅ App montada correctamente en el DOM");
            })
            .catch((err) => {
                ERR("mount() falló:", err);
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
    LOG("─── runExtraProductsWizard START ───");
    LOG("recordId:", recordId, "| triggerType:", triggerType);
    LOG("_processedOrders:", [..._processedOrders]);

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

    if (!config) {
        ERR("Config es null/undefined");
        return true;
    }
    if (!config.enabled) {
        LOG("⏭ Módulo desactivado en configuración (enabled=false)");
        return true;
    }
    if (config.has_extra_products) {
        LOG("⏭ La orden ya tiene productos adicionales");
        _processedOrders.add(recordId);
        return true;
    }
    if (config.extra_products_dismissed) {
        LOG("⏭ Pop-up ya fue descartado para esta orden");
        _processedOrders.add(recordId);
        return true;
    }

    const shouldTrigger = triggerType === "confirm" ? config.trigger_confirm : config.trigger_print;
    LOG("shouldTrigger:", shouldTrigger, "| trigger_confirm:", config.trigger_confirm, "| trigger_print:", config.trigger_print);
    if (!shouldTrigger) {
        LOG("⏭ El trigger no está activo para este tipo de acción");
        return true;
    }

    LOG("order_state:", config.order_state);
    if (!["draft", "sent"].includes(config.order_state)) {
        LOG("⏭ Estado de orden no aplica:", config.order_state);
        _processedOrders.add(recordId);
        return true;
    }

    LOG("category_ids configuradas:", config.category_ids);
    if (!config.category_ids || config.category_ids.length === 0) {
        LOG("⚠ No hay categorías configuradas en Ajustes. Ve a Ajustes > Ventas > Productos Adicionales y selecciona categorías.");
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
        LOG("⚠ No hay productos en las categorías configuradas. Verifica que los productos tengan 'sale_ok=True' y estén en las categorías correctas.");
        _processedOrders.add(recordId);
        return true;
    }

    // 3. Abrir wizard
    LOG("3. Abriendo wizard con", products.length, "productos...");
    const result = await openWizard(env, products);
    LOG("Resultado del wizard:", result.action);

    if (result.action === "confirm") {
        LOG("4. Agregando productos:", result.data);
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
        this._epEnv = useEnv();
        // Este log aparece CADA VEZ que se crea una instancia de FormController
        // Si nunca aparece, el patch no está siendo cargado
        LOG("FormController.setup() — patch activo");
    },

    async beforeExecuteActionButton(clickParams) {
        const resModel = this.model?.root?.resModel;
        LOG("beforeExecuteActionButton llamado | resModel:", resModel, "| clickParams:", JSON.stringify(clickParams));

        if (resModel !== "sale.order") {
            LOG("⏭ No es sale.order, pasando al handler original");
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const recordId = this.model?.root?.resId;
        LOG("recordId:", recordId);
        if (!recordId) {
            LOG("⚠ Sin recordId, pasando al handler original");
            return super.beforeExecuteActionButton?.(clickParams) ?? true;
        }

        const btnName   = (clickParams?.name   || "").toLowerCase();
        const btnType   = (clickParams?.type   || "").toLowerCase();
        const btnString = (clickParams?.string || "").toLowerCase();

        LOG("Botón detectado → name:", btnName, "| type:", btnType, "| string:", btnString);

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

        LOG("isConfirm:", isConfirm, "| isPrint:", isPrint);

        if (!isConfirm && !isPrint) {
            LOG("⏭ Botón no es Confirmar ni Imprimir, pasando al handler original");
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

        LOG("shouldContinue:", shouldContinue);
        if (!shouldContinue) return false;
        return super.beforeExecuteActionButton?.(clickParams) ?? true;
    },
});

LOG("✅ Patch registrado. Si ves este mensaje, el archivo JS fue cargado correctamente.");