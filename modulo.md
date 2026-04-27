## ./__init__.py
```py
# -*- coding: utf-8 -*-
from . import models
```

## ./__manifest__.py
```py
# -*- coding: utf-8 -*-
{
    'name': 'Sale Extra Products Wizard',
    'version': '19.0.1.0.0',
    'summary': 'Pop-up inteligente para cotizar productos adicionales en SO',
    'description': """
        Muestra un pop-up elegante antes de confirmar o imprimir una Orden de Venta,
        sugiriendo productos adicionales (adhesivos, selladores, etc.) configurables por categoría.
        Identifica y agrupa los productos adicionales en una sección separada de la SO.
    """,
    'author': 'Alphaqueb Consulting SAS',
    'category': 'Sales',
    'depends': ['sale_management'],
    'data': [
        'security/ir.model.access.csv',
        'data/product_category_data.xml',
        'views/res_config_settings_views.xml',
        'views/sale_order_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'sale_extra_products_wizard/static/src/scss/extra_products_wizard.scss',
            'sale_extra_products_wizard/static/src/xml/extra_products_wizard.xml',
            'sale_extra_products_wizard/static/src/components/extra_products_wizard.js',
            'sale_extra_products_wizard/static/src/components/sale_order_patch.js',
        ],
    },
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}
```

## ./data/product_category_data.xml
```xml
<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <!-- Categorías de productos adicionales sugeridas -->
    <!-- Puedes reutilizar categorías existentes desde Ajustes > Productos Adicionales -->

    <record id="product_categ_adhesivos" model="product.category">
        <field name="name">Adhesivos</field>
    </record>

    <record id="product_categ_selladores" model="product.category">
        <field name="name">Selladores</field>
    </record>

    <record id="product_categ_herramientas" model="product.category">
        <field name="name">Herramientas</field>
    </record>

    <record id="product_categ_accesorios" model="product.category">
        <field name="name">Accesorios</field>
    </record>

    <record id="product_categ_limpiadores" model="product.category">
        <field name="name">Limpiadores</field>
    </record>

</odoo>```

## ./models/__init__.py
```py
# -*- coding: utf-8 -*-
from . import res_config_settings
from . import sale_order
from . import sale_order_line
```

## ./models/res_config_settings.py
```py
# -*- coding: utf-8 -*-
from odoo import api, fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    # Many2many real para la UI (sin config_parameter directo)
    extra_products_category_ids = fields.Many2many(
        'product.category',
        'config_extra_product_category_rel',
        'config_id',
        'category_id',
        string='Categorías de Productos Adicionales',
    )
    extra_products_trigger_confirm = fields.Boolean(
        string='Disparar al Confirmar',
        default=True,
        config_parameter='sale_extra_products_wizard.trigger_confirm',
    )
    extra_products_trigger_print = fields.Boolean(
        string='Disparar al Imprimir',
        default=True,
        config_parameter='sale_extra_products_wizard.trigger_print',
    )
    extra_products_wizard_enabled = fields.Boolean(
        string='Activar Pop-up de Productos Adicionales',
        default=True,
        config_parameter='sale_extra_products_wizard.enabled',
    )

    def get_values(self):
        res = super().get_values()
        ICP = self.env['ir.config_parameter'].sudo()
        ids_str = ICP.get_param('sale_extra_products_wizard.category_ids', '')
        category_ids = []
        if ids_str:
            try:
                category_ids = [int(x) for x in ids_str.split(',') if x.strip().isdigit()]
            except Exception:
                category_ids = []
        res['extra_products_category_ids'] = [(6, 0, category_ids)]
        return res

    def set_values(self):
        super().set_values()
        ICP = self.env['ir.config_parameter'].sudo()
        category_ids = self.extra_products_category_ids.ids
        ICP.set_param(
            'sale_extra_products_wizard.category_ids',
            ','.join(str(i) for i in category_ids)
        )```

## ./models/sale_order.py
```py
# -*- coding: utf-8 -*-
from odoo import api, fields, models


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    has_extra_products = fields.Boolean(
        string='Tiene Productos Adicionales',
        compute='_compute_has_extra_products',
        store=True,
    )
    extra_products_dismissed = fields.Boolean(
        string='Pop-up Descartado',
        default=False,
    )

    @api.depends('order_line', 'order_line.is_extra_product')
    def _compute_has_extra_products(self):
        for order in self:
            order.has_extra_products = any(
                line.is_extra_product for line in order.order_line
            )

    def _get_category_ids_from_param(self):
        ICP = self.env['ir.config_parameter'].sudo()
        ids_str = ICP.get_param('sale_extra_products_wizard.category_ids', '')
        if not ids_str:
            return []
        try:
            return [int(x) for x in ids_str.split(',') if x.strip().isdigit()]
        except Exception:
            return []

    def get_extra_products_config(self):
        ICP = self.env['ir.config_parameter'].sudo()
        enabled = ICP.get_param('sale_extra_products_wizard.enabled', 'True') == 'True'
        trigger_confirm = ICP.get_param('sale_extra_products_wizard.trigger_confirm', 'True') == 'True'
        trigger_print = ICP.get_param('sale_extra_products_wizard.trigger_print', 'True') == 'True'
        category_ids = self._get_category_ids_from_param()

        return {
            'enabled': enabled,
            'trigger_confirm': trigger_confirm,
            'trigger_print': trigger_print,
            'category_ids': category_ids,
            'has_extra_products': self.has_extra_products,
            'extra_products_dismissed': self.extra_products_dismissed,
            'order_state': self.state,
        }

    def get_suggested_extra_products(self):
        category_ids = self._get_category_ids_from_param()
        if not category_ids:
            return []

        products = self.env['product.product'].search([
            ('categ_id', 'in', category_ids),
            ('sale_ok', '=', True),
            ('active', '=', True),
        ], order='categ_id, name')

        existing_product_ids = self.order_line.mapped('product_id').ids
        currency_code = self.currency_id.name  # 'MXN' o 'USD'

        result = []
        for product in products:
            tmpl = product.product_tmpl_id

            # Precio alto según moneda activa de la orden
            if currency_code == 'USD':
                price = tmpl.x_price_usd_1 if tmpl.x_price_usd_1 > 0 else product.lst_price
            else:
                price = tmpl.x_price_mxn_1 if tmpl.x_price_mxn_1 > 0 else product.lst_price

            result.append({
                'id': product.id,
                'name': product.name,
                'display_name': product.display_name,
                'categ_name': product.categ_id.name,
                'categ_id': product.categ_id.id,
                'price': price,
                'currency_symbol': self.currency_id.symbol or '$',
                'currency_code': currency_code,
                'uom_name': product.uom_id.name,
                'image_url': f'/web/image/product.product/{product.id}/image_1920',
                'already_in_order': product.id in existing_product_ids,
                'description': product.description_sale or '',
            })

        return result

    def action_dismiss_extra_products_wizard(self):
        self.write({'extra_products_dismissed': True})
        return True

    def action_add_extra_products(self, products_data):
        for item in products_data:
            product = self.env['product.product'].browse(item['product_id'])
            if not product.exists():
                continue

            existing_line = self.order_line.filtered(
                lambda l: l.product_id.id == item['product_id'] and l.is_extra_product
            )

            if existing_line:
                existing_line[0].product_uom_qty += item.get('quantity', 1)
            else:
                self.env['sale.order.line'].create({
                    'order_id': self.id,
                    'product_id': product.id,
                    'product_uom_qty': item.get('quantity', 1),
                    'price_unit': item.get('price_unit', product.lst_price),
                    'is_extra_product': True,
                    'name': product.get_product_multiline_description_sale(),
                })

        self.write({'extra_products_dismissed': True})
        return True

    def action_reset_extra_products_wizard(self):
        self.write({'extra_products_dismissed': False})
        return True```

## ./models/sale_order_line.py
```py
# -*- coding: utf-8 -*-
from odoo import fields, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    is_extra_product = fields.Boolean(
        string='Producto Adicional',
        default=False,
        help='Indica que esta línea fue agregada como producto adicional desde el pop-up',
    )
```

## ./static/src/components/extra_products_wizard.js
```js
/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

export class ExtraProductsDialog extends Component {
    static template = "sale_extra_products_wizard.ExtraProductsDialog";
    static components = { Dialog };

    static props = {
        products: { type: Array },
        onConfirm: { type: Function },
        onSkip: { type: Function },
        onDismiss: { type: Function },
        close: { type: Function },
    };

    setup() {
        this.state = useState({
            activeCategory: null,
            selected: {},
        });
    }

    get categories() {
        const map = {};
        for (const p of this.props.products) {
            if (!map[p.categ_id]) {
                map[p.categ_id] = { id: p.categ_id, name: p.categ_name, count: 0 };
            }
            map[p.categ_id].count++;
        }
        return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
    }

    get filteredProducts() {
        if (!this.state.activeCategory) return this.props.products;
        return this.props.products.filter(p => p.categ_id === this.state.activeCategory);
    }

    get selectedCount() {
        return Object.keys(this.state.selected).length;
    }

    get totalItems() {
        return Object.values(this.state.selected).reduce((acc, q) => acc + q, 0);
    }

    get currencySymbol() {
        return this.props.products[0]?.currency_symbol || "$";
    }

    get totalAmount() {
        let total = 0;
        for (const [prodIdStr, qty] of Object.entries(this.state.selected)) {
            const product = this.props.products.find(p => p.id === parseInt(prodIdStr));
            if (product) total += product.price * qty;
        }
        return total;
    }

    isSelected(productId) {
        return productId in this.state.selected;
    }

    getQty(productId) {
        return this.state.selected[productId] || 1;
    }

    formatPrice(amount) {
        return amount.toLocaleString("es-MX", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    setCategory(categoryId) {
        this.state.activeCategory = categoryId;
    }

    toggleProduct(product) {
        if (product.already_in_order) return;
        if (this.isSelected(product.id)) {
            const newSelected = { ...this.state.selected };
            delete newSelected[product.id];
            this.state.selected = newSelected;
        } else {
            this.state.selected = { ...this.state.selected, [product.id]: 1 };
        }
    }

    changeQty(productId, delta) {
        if (!this.isSelected(productId)) return;
        const newQty = (this.state.selected[productId] || 1) + delta;
        if (newQty <= 0) {
            const newSelected = { ...this.state.selected };
            delete newSelected[productId];
            this.state.selected = newSelected;
        } else {
            this.state.selected = { ...this.state.selected, [productId]: newQty };
        }
    }

    setQty(productId, value) {
        const qty = parseInt(value) || 1;
        if (qty <= 0) {
            const newSelected = { ...this.state.selected };
            delete newSelected[productId];
            this.state.selected = newSelected;
        } else {
            this.state.selected = { ...this.state.selected, [productId]: qty };
        }
    }

    onImgError(ev) {
        ev.target.style.display = "none";
        const placeholder = document.createElement("div");
        placeholder.className = "o_ep_product_img_placeholder";
        placeholder.textContent = "📦";
        ev.target.parentNode.insertBefore(placeholder, ev.target);
    }

    onConfirm() {
        if (this.selectedCount === 0) return;
        const productsToAdd = [];
        for (const [prodIdStr, qty] of Object.entries(this.state.selected)) {
            const prodId = parseInt(prodIdStr);
            const product = this.props.products.find(p => p.id === prodId);
            if (product) {
                productsToAdd.push({
                    product_id: prodId,
                    quantity: qty,
                    price_unit: product.price,
                });
            }
        }
        this.props.onConfirm(productsToAdd);
        this.props.close();
    }

    onSkip() {
        this.props.onSkip();
        this.props.close();
    }

    onDismiss() {
        this.props.onDismiss();
        this.props.close();
    }
}```

## ./static/src/components/sale_order_patch.js
```js
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

LOG("✅ Patches registrados.");```

## ./static/src/scss/extra_products_wizard.scss
```scss
/* ==========================================================================
   Extra Products Wizard — Alphaqueb Consulting SAS / STONIA
   Paleta: Azul marino profundo + Blanco + Acentos esmeralda
   ========================================================================== */

:root {
    --ep-navy:        #0d1b2a;
    --ep-navy-mid:    #1b2f4a;
    --ep-blue:        #0f3460;
    --ep-blue-light:  #1a5276;
    --ep-accent:      #e94560;
    --ep-emerald:     #10b981;
    --ep-emerald-dk:  #059669;

    --ep-bg:          #f0f4f8;
    --ep-surface:     #ffffff;
    --ep-surface-2:   #f8fafc;
    --ep-border:      #dde3ea;

    --ep-text-primary:   #0d1b2a;
    --ep-text-secondary: #4a5568;
    --ep-text-muted:     #718096;
    --ep-text-on-dark:   #ffffff;
    --ep-text-on-dark-2: rgba(255,255,255,0.75);

    --ep-shadow-sm:  0 1px 3px rgba(13,27,42,0.08), 0 1px 2px rgba(13,27,42,0.04);
    --ep-shadow-md:  0 4px 16px rgba(13,27,42,0.12), 0 2px 6px rgba(13,27,42,0.06);
    --ep-shadow-lg:  0 20px 60px rgba(13,27,42,0.28), 0 8px 20px rgba(13,27,42,0.12);
    --ep-radius:     14px;
    --ep-radius-sm:  8px;
}

/* ── Overlay ──────────────────────────────────────────────────────────────── */
.o_extra_products_overlay {
    position: fixed;
    inset: 0;
    background: rgba(8, 15, 28, 0.82);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    z-index: 10050;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: epFadeIn 0.22s ease;
}

@keyframes epFadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
}

/* ── Dialog ───────────────────────────────────────────────────────────────── */
.o_extra_products_dialog {
    background: var(--ep-surface);
    border-radius: 20px;
    box-shadow: var(--ep-shadow-lg);
    border: 1px solid rgba(255,255,255,0.12);
    width: 980px;
    max-width: 96vw;
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: epSlideIn 0.3s cubic-bezier(0.34, 1.3, 0.64, 1);
}

@keyframes epSlideIn {
    from { opacity: 0; transform: scale(0.88) translateY(28px); }
    to   { opacity: 1; transform: scale(1)    translateY(0); }
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.o_ep_dialog_header {
    background: linear-gradient(135deg, var(--ep-navy) 0%, var(--ep-navy-mid) 50%, var(--ep-blue) 100%);
    color: var(--ep-text-on-dark);
    padding: 22px 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
}

.o_ep_dialog_header::after {
    content: '';
    position: absolute;
    right: -60px;
    top: -60px;
    width: 200px;
    height: 200px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.06) 0%, transparent 65%);
    pointer-events: none;
}

.o_ep_header_left {
    display: flex;
    align-items: center;
    gap: 14px;
    z-index: 1;
}

.o_ep_header_icon {
    font-size: 2.2rem;
    filter: drop-shadow(0 2px 6px rgba(233,69,96,0.5));
    flex-shrink: 0;
    line-height: 1;
}

.o_ep_dialog_header h2 {
    font-size: 1.2rem;
    font-weight: 700;
    margin: 0 0 3px;
    color: var(--ep-text-on-dark);
    letter-spacing: -0.2px;
    line-height: 1.2;
}

.o_ep_dialog_header p {
    font-size: 0.78rem;
    color: var(--ep-text-on-dark-2);
    margin: 0;
    line-height: 1.3;
}

.o_ep_close_btn {
    background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.2);
    color: var(--ep-text-on-dark);
    width: 34px;
    height: 34px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    flex-shrink: 0;
    z-index: 1;
    line-height: 1;
}

.o_ep_close_btn:hover {
    background: rgba(233,69,96,0.7);
    border-color: transparent;
    transform: rotate(90deg) scale(1.1);
}

/* ── Tabs de categorías ───────────────────────────────────────────────────── */
.o_ep_category_tabs {
    display: flex;
    gap: 2px;
    padding: 12px 20px 0;
    background: var(--ep-navy);
    border-bottom: 3px solid var(--ep-border);
    overflow-x: auto;
    flex-shrink: 0;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.2) transparent;
}

.o_ep_category_tabs::-webkit-scrollbar { height: 3px; }
.o_ep_category_tabs::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.25);
    border-radius: 99px;
}

.o_ep_tab {
    padding: 8px 16px;
    border: none;
    background: rgba(255,255,255,0.08);
    border-radius: var(--ep-radius-sm) var(--ep-radius-sm) 0 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: rgba(255,255,255,0.65);
    cursor: pointer;
    white-space: nowrap;
    border-bottom: 3px solid transparent;
    margin-bottom: -3px;
    transition: all 0.18s;
    display: flex;
    align-items: center;
    gap: 6px;
}

.o_ep_tab:hover {
    background: rgba(255,255,255,0.15);
    color: var(--ep-text-on-dark);
}

.o_ep_tab.active {
    background: var(--ep-surface);
    color: var(--ep-blue);
    border-bottom-color: var(--ep-blue);
}

.o_ep_tab_count {
    background: rgba(255,255,255,0.18);
    color: rgba(255,255,255,0.9);
    border-radius: 99px;
    padding: 1px 7px;
    font-size: 0.68rem;
    font-weight: 700;
    min-width: 20px;
    text-align: center;
}

.o_ep_tab.active .o_ep_tab_count {
    background: #dbeafe;
    color: #1e40af;
}

/* ── Grid de productos ────────────────────────────────────────────────────── */
.o_ep_products_body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    background: var(--ep-bg);
    scrollbar-width: thin;
    scrollbar-color: var(--ep-border) transparent;
}

.o_ep_products_body::-webkit-scrollbar { width: 5px; }
.o_ep_products_body::-webkit-scrollbar-thumb {
    background: var(--ep-border);
    border-radius: 99px;
}

.o_ep_products_grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 16px;
}

/* ══════════════════════════════════════════════════════════════════════════════
   TARJETA DE PRODUCTO — Imagen grande arriba + texto compacto abajo
   ══════════════════════════════════════════════════════════════════════════════ */
.o_ep_product_card {
    position: relative;
    border-radius: var(--ep-radius);
    overflow: hidden;
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: var(--ep-shadow-sm);
    user-select: none;
    display: flex;
    flex-direction: column;
    border: 2px solid var(--ep-border);
    background: var(--ep-surface);
}

.o_ep_product_card:hover:not(.already_in_order) {
    box-shadow: var(--ep-shadow-md), 0 0 0 3px rgba(15,52,96,0.10);
    transform: translateY(-4px);
    border-color: var(--ep-blue);
}

.o_ep_product_card.selected {
    border-color: var(--ep-blue);
    box-shadow: var(--ep-shadow-md), 0 0 0 3px rgba(15,52,96,0.15);
}

.o_ep_product_card.already_in_order {
    cursor: default;
    border-color: var(--ep-emerald);
}

/* ── Área de imagen (ocupa la mayor parte del card) ───────────────────────── */
.o_ep_product_img_area {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    background: linear-gradient(135deg, #f8fafc 0%, #edf2f7 100%);
    overflow: hidden;
    flex-shrink: 0;
}

.o_ep_product_img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    position: relative;
    z-index: 1;
    transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.o_ep_product_card:hover:not(.already_in_order) .o_ep_product_img {
    transform: scale(1.06);
}

.o_ep_product_img_placeholder_bg {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 4rem;
    color: var(--ep-border);
    background: linear-gradient(135deg, #f0f4f8 0%, #e2e8f0 100%);
    z-index: 0;
    pointer-events: none;
}

/* ── Badges (sobre la imagen) ─────────────────────────────────────────────── */
.o_ep_check_badge {
    position: absolute;
    top: 10px;
    left: 10px;
    background: var(--ep-blue);
    color: #ffffff;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 700;
    box-shadow: 0 2px 10px rgba(15,52,96,0.5);
    z-index: 5;
    animation: epBounce 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    border: 2px solid rgba(255,255,255,0.9);
}

@keyframes epBounce {
    from { transform: scale(0); }
    to   { transform: scale(1); }
}

.o_ep_already_badge {
    position: absolute;
    top: 10px;
    right: 10px;
    background: var(--ep-emerald);
    color: #ffffff;
    font-size: 0.6rem;
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 99px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    z-index: 5;
    box-shadow: 0 2px 8px rgba(16,185,129,0.4);
    border: 1.5px solid rgba(255,255,255,0.7);
}

/* ── Control de cantidad (flotante sobre la imagen) ───────────────────────── */
.o_ep_qty_control {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(13, 27, 42, 0.90);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 99px;
    padding: 6px 12px;
    z-index: 5;
    animation: epFadeUp 0.2s ease;
    border: 1px solid rgba(255,255,255,0.15);
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
}

@keyframes epFadeUp {
    from { opacity: 0; transform: translateX(-50%) translateY(6px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.o_ep_qty_btn {
    background: none;
    border: none;
    font-size: 1.15rem;
    font-weight: 700;
    cursor: pointer;
    line-height: 1;
    padding: 0 5px;
    color: var(--ep-text-on-dark);
    transition: color 0.15s, transform 0.1s;
}

.o_ep_qty_btn:hover {
    color: #6ee7b7;
    transform: scale(1.25);
}

.o_ep_qty_input {
    width: 34px;
    text-align: center;
    border: none;
    background: transparent;
    font-weight: 800;
    font-size: 0.95rem;
    color: var(--ep-text-on-dark);
    outline: none;
    -moz-appearance: textfield;
}

.o_ep_qty_input::-webkit-outer-spin-button,
.o_ep_qty_input::-webkit-inner-spin-button { -webkit-appearance: none; }

/* ── Info del producto (sección inferior, fuera de la imagen) ─────────────── */
.o_ep_product_info {
    padding: 12px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--ep-surface);
    border-top: 1px solid var(--ep-border);
}

.o_ep_product_card.selected .o_ep_product_info {
    background: #eff6ff;
    border-top-color: rgba(15,52,96,0.15);
}

.o_ep_product_card.already_in_order .o_ep_product_info {
    background: #f0fdf4;
    border-top-color: rgba(16,185,129,0.2);
}

.o_ep_product_categ {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--ep-blue);
    background: #dbeafe;
    padding: 2px 8px;
    border-radius: 99px;
    align-self: flex-start;
}

.o_ep_product_card.selected .o_ep_product_categ {
    background: rgba(15,52,96,0.12);
    color: var(--ep-blue);
}

.o_ep_product_card.already_in_order .o_ep_product_categ {
    background: rgba(16,185,129,0.15);
    color: var(--ep-emerald-dk);
}

.o_ep_product_name {
    font-size: 0.84rem;
    font-weight: 700;
    color: var(--ep-text-primary);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.o_ep_product_desc {
    font-size: 0.68rem;
    color: var(--ep-text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-style: italic;
}

.o_ep_product_price_row {
    display: flex;
    align-items: baseline;
    gap: 4px;
    margin-top: 2px;
}

.o_ep_product_price {
    font-size: 1.05rem;
    font-weight: 800;
    color: var(--ep-blue);
    letter-spacing: -0.3px;
}

.o_ep_currency {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--ep-blue);
    margin-right: 1px;
    vertical-align: super;
}

.o_ep_product_uom {
    font-size: 0.62rem;
    font-weight: 500;
    color: var(--ep-text-muted);
}

/* ── Estado vacío ─────────────────────────────────────────────────────────── */
.o_ep_empty_state {
    text-align: center;
    padding: 52px 24px;
    color: var(--ep-text-muted);
}

.o_ep_empty_icon {
    font-size: 3.5rem;
    margin-bottom: 14px;
    display: block;
    filter: grayscale(0.2);
}

.o_ep_empty_state p {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--ep-text-secondary);
}

/* ── Barra resumen carrito ────────────────────────────────────────────────── */
.o_ep_cart_bar {
    background: var(--ep-navy-mid);
    border-top: 1px solid rgba(255,255,255,0.1);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-shrink: 0;
    animation: epFadeUp2 0.2s ease;
}

@keyframes epFadeUp2 {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
}

.o_ep_cart_label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: rgba(255,255,255,0.55);
    font-weight: 600;
    margin-bottom: 2px;
}

.o_ep_cart_items {
    font-size: 0.92rem;
    font-weight: 700;
    color: var(--ep-text-on-dark);
}

.o_ep_total_label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: rgba(255,255,255,0.55);
    font-weight: 600;
    text-align: right;
    margin-bottom: 2px;
}

.o_ep_total_amount {
    font-size: 1.3rem;
    font-weight: 900;
    color: #6ee7b7;
    text-align: right;
    letter-spacing: -0.5px;
}

/* ── Barra de acciones ────────────────────────────────────────────────────── */
.o_ep_action_bar {
    padding: 14px 24px 18px;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--ep-surface);
    border-top: 2px solid var(--ep-border);
    flex-shrink: 0;
}

.o_ep_action_hint {
    flex: 1;
    font-size: 0.76rem;
    color: var(--ep-text-muted);
    font-style: italic;
}

.o_ep_btn {
    padding: 11px 22px;
    border-radius: var(--ep-radius-sm);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    line-height: 1;
}

.o_ep_btn_icon {
    font-size: 1rem;
}

.o_ep_btn_skip {
    background: #fef2f2;
    color: #b91c1c;
    border: 1.5px solid #fecaca;
}

.o_ep_btn_skip:hover {
    background: #fee2e2;
    border-color: #f87171;
    color: #991b1b;
}

.o_ep_btn_add {
    background: linear-gradient(135deg, var(--ep-blue) 0%, var(--ep-blue-light) 100%);
    color: #ffffff;
    padding: 11px 28px;
    box-shadow: 0 4px 14px rgba(15,52,96,0.3);
}

.o_ep_btn_add:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 6px 22px rgba(15,52,96,0.4);
    background: linear-gradient(135deg, #0c2d54 0%, #154569 100%);
}

.o_ep_btn_add:disabled {
    background: #94a3b8;
    color: #f1f5f9;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
    opacity: 0.7;
}

/* ── Toast ────────────────────────────────────────────────────────────────── */
.o_ep_toast {
    position: fixed;
    bottom: 32px;
    right: 32px;
    background: var(--ep-navy);
    color: var(--ep-text-on-dark);
    padding: 14px 20px;
    border-radius: 12px;
    font-size: 0.875rem;
    font-weight: 500;
    z-index: 10100;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    max-width: 360px;
    animation: epToastIn 0.3s cubic-bezier(0.34, 1.3, 0.64, 1);
}

.o_ep_toast.success { border-left: 4px solid #34d399; }
.o_ep_toast.info    { border-left: 4px solid #60a5fa; }

.o_ep_toast_icon {
    font-size: 1.1rem;
    flex-shrink: 0;
}

@keyframes epToastIn {
    from { opacity: 0; transform: translateY(20px) scale(0.92); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
}

/* ── Ajustes dentro del Dialog de Odoo ────────────────────────────────────── */
.o_dialog .o_ep_dialog_header {
    margin: -1rem -1rem 0;
    border-radius: 8px 8px 0 0;
}

.o_dialog .o_ep_products_body {
    max-height: 50vh;
}

.o_dialog .o_ep_category_tabs {
    margin: 0 -1rem;
}

.o_dialog .o_ep_cart_bar,
.o_dialog .o_ep_action_bar {
    margin: 0 -1rem -1rem;
}

/* ── Idle countdown ───────────────────────────────────────────────────────── */
.o_ep_idle_indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    z-index: 1;
}

.o_ep_idle_ring {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 3px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: epSpin 1s linear infinite;
}

@keyframes epSpin {
    to { transform: rotate(360deg); }
}

.o_ep_idle_count {
    font-size: 1rem;
    font-weight: 800;
    color: #fff;
    animation: epSpinReverse 1s linear infinite;
}

@keyframes epSpinReverse {
    to { transform: rotate(-360deg); }
}

.o_ep_idle_label {
    font-size: 0.62rem;
    color: rgba(255,255,255,0.7);
    text-align: center;
    white-space: nowrap;
}

.o_ep_idle_ready {
    background: rgba(16,185,129,0.25);
    border: 1px solid rgba(16,185,129,0.5);
    color: #6ee7b7;
    padding: 6px 14px;
    border-radius: 99px;
    font-size: 0.78rem;
    font-weight: 600;
    z-index: 1;
}

/* ── Banner bloqueado ─────────────────────────────────────────────────────── */
.o_ep_locked_banner {
    background: #fffbeb;
    border-bottom: 1px solid #fde68a;
    padding: 8px 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.82rem;
    color: #92400e;
    flex-shrink: 0;
}

.o_ep_locked_icon {
    font-size: 1.1rem;
}

.o_ep_product_card.locked {
    cursor: default;
    opacity: 0.85;
}

.o_ep_product_card.locked:hover:not(.already_in_order) {
    transform: none;
    border-color: var(--ep-border);
    box-shadow: var(--ep-shadow-sm);
}

/* ── Responsive ───────────────────────────────────────────────────────────── */
@media (max-width: 640px) {
    .o_ep_products_grid {
        grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
        gap: 10px;
    }
    .o_ep_action_bar { flex-wrap: wrap; }
    .o_ep_action_hint { display: none; }
    .o_ep_btn { flex: 1; justify-content: center; }
}```

## ./static/src/xml/extra_products_wizard.xml
```xml
<?xml version="1.0" encoding="utf-8"?>
<templates xml:space="preserve">

    <t t-name="sale_extra_products_wizard.ExtraProductsDialog">
        <Dialog title="'Productos Adicionales Recomendados'" size="'xl'" footer="false">

            <!-- ── Header interno ───────────────────────────── -->
            <div class="o_ep_dialog_header">
                <div class="o_ep_header_left">
                    <span class="o_ep_header_icon">✨</span>
                    <div>
                        <h2>Productos Adicionales Recomendados</h2>
                        <p>Complementa esta orden con nuestros productos de instalación y cuidado</p>
                    </div>
                </div>
            </div>

            <!-- ── Tabs de categorías ────────────────────────── -->
            <div class="o_ep_category_tabs" t-if="categories.length > 1">
                <button
                    class="o_ep_tab"
                    t-att-class="{ active: state.activeCategory === null }"
                    t-on-click="() => this.setCategory(null)"
                >
                    Todos <span class="o_ep_tab_count" t-esc="props.products.length"/>
                </button>
                <t t-foreach="categories" t-as="cat" t-key="cat.id">
                    <button
                        class="o_ep_tab"
                        t-att-class="{ active: state.activeCategory === cat.id }"
                        t-on-click="() => this.setCategory(cat.id)"
                    >
                        <t t-esc="cat.name"/>
                        <span class="o_ep_tab_count" t-esc="cat.count"/>
                    </button>
                </t>
            </div>

            <!-- ── Grid de productos ─────────────────────────── -->
            <div class="o_ep_products_body">
                <t t-if="filteredProducts.length === 0">
                    <div class="o_ep_empty_state">
                        <div class="o_ep_empty_icon">📦</div>
                        <p>No hay productos disponibles en esta categoría</p>
                    </div>
                </t>
                <div class="o_ep_products_grid" t-else="">
                    <t t-foreach="filteredProducts" t-as="product" t-key="product.id">
                        <div
                            class="o_ep_product_card"
                            t-att-class="{
                                selected: isSelected(product.id),
                                already_in_order: product.already_in_order
                            }"
                            t-on-click="() => this.toggleProduct(product)"
                        >
                            <!-- Badge de selección -->
                            <div class="o_ep_check_badge" t-if="isSelected(product.id)">✓</div>
                            <div class="o_ep_already_badge" t-if="product.already_in_order">En orden</div>

                            <!-- Imagen grande arriba -->
                            <div class="o_ep_product_img_area">
                                <img
                                    class="o_ep_product_img"
                                    t-att-src="product.image_url"
                                    t-att-alt="product.name"
                                    t-on-error="onImgError"
                                    loading="lazy"
                                />
                                <div class="o_ep_product_img_placeholder_bg">📦</div>

                                <!-- Qty control flotante sobre la imagen -->
                                <div class="o_ep_qty_control" t-if="isSelected(product.id)" t-on-click.stop="">
                                    <button class="o_ep_qty_btn" t-on-click="() => this.changeQty(product.id, -1)">−</button>
                                    <input
                                        type="number"
                                        class="o_ep_qty_input"
                                        min="1"
                                        t-att-value="getQty(product.id)"
                                        t-on-change="(ev) => this.setQty(product.id, ev.target.value)"
                                    />
                                    <button class="o_ep_qty_btn" t-on-click="() => this.changeQty(product.id, 1)">+</button>
                                </div>
                            </div>

                            <!-- Info del producto ABAJO, fuera de la imagen -->
                            <div class="o_ep_product_info">
                                <div class="o_ep_product_categ" t-esc="product.categ_name"/>
                                <div class="o_ep_product_name" t-esc="product.name"/>
                                <div class="o_ep_product_desc" t-if="product.description" t-esc="product.description"/>
                                <div class="o_ep_product_price_row">
                                    <div class="o_ep_product_price">
                                        <span class="o_ep_currency" t-esc="product.currency_symbol"/>
                                        <span t-esc="formatPrice(product.price)"/>
                                    </div>
                                    <span class="o_ep_product_uom">/ <t t-esc="product.uom_name"/></span>
                                </div>
                            </div>
                        </div>
                    </t>
                </div>
            </div>

            <!-- ── Resumen del carrito ───────────────────────── -->
            <div class="o_ep_cart_bar" t-if="selectedCount > 0">
                <div class="o_ep_cart_summary">
                    <div class="o_ep_cart_label">Seleccionados</div>
                    <div class="o_ep_cart_items">
                        <t t-esc="selectedCount"/> producto(s) —
                        <t t-esc="totalItems"/> unidad(es)
                    </div>
                </div>
                <div class="o_ep_cart_total">
                    <div class="o_ep_total_label">Total adicional (aprox.)</div>
                    <div class="o_ep_total_amount">
                        <t t-esc="currencySymbol"/>&#160;<t t-esc="formatPrice(totalAmount)"/>
                    </div>
                </div>
            </div>

            <!-- ── Acciones ──────────────────────────────────── -->
            <div class="o_ep_action_bar">
                <div class="o_ep_action_hint" t-if="selectedCount === 0">
                    Selecciona productos o elige una opción →
                </div>
                <button class="o_ep_btn o_ep_btn_skip" t-on-click="onSkip">
                    <span class="o_ep_btn_icon">→</span>
                    Continuar sin adicionales
                </button>
                <button
                    class="o_ep_btn o_ep_btn_add"
                    t-att-disabled="selectedCount === 0 ? true : undefined"
                    t-on-click="onConfirm"
                >
                    <t t-if="selectedCount > 0">
                        <span class="o_ep_btn_icon">✓</span>
                        Agregar <t t-esc="selectedCount"/> producto(s) a la orden
                    </t>
                    <t t-else="">
                        <span class="o_ep_btn_icon">＋</span>
                        Selecciona productos para agregar
                    </t>
                </button>
            </div>

        </Dialog>
    </t>

</templates>```

## ./views/res_config_settings_views.xml
```xml
<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="res_config_settings_view_form_extra_products" model="ir.ui.view">
        <field name="name">res.config.settings.view.form.extra.products</field>
        <field name="model">res.config.settings</field>
        <field name="inherit_id" ref="sale.res_config_settings_view_form"/>
        <field name="arch" type="xml">
            <!-- Agregar al final del formulario de configuración de ventas -->
            <xpath expr="//form" position="inside">
                <app string="Productos Adicionales" name="sale_extra_products_wizard">
                    <block title="Pop-up de Productos Adicionales en Órdenes de Venta">
                        <setting string="Activar Pop-up de Productos Adicionales"
                                 help="Muestra un pop-up para sugerir productos complementarios al vendedor antes de confirmar o imprimir">
                            <field name="extra_products_wizard_enabled"/>
                        </setting>
                        <setting string="Categorías de Productos Adicionales"
                                 help="Productos de estas categorías aparecerán en el pop-up (ej: Adhesivos, Selladores)"
                                 invisible="not extra_products_wizard_enabled">
                            <field name="extra_products_category_ids" widget="many2many_tags"/>
                        </setting>
                        <setting string="Disparar al Confirmar Orden"
                                 invisible="not extra_products_wizard_enabled">
                            <field name="extra_products_trigger_confirm"/>
                        </setting>
                        <setting string="Disparar al Imprimir / Reportes"
                                 invisible="not extra_products_wizard_enabled">
                            <field name="extra_products_trigger_print"/>
                        </setting>
                    </block>
                </app>
            </xpath>
        </field>
    </record>
</odoo>```

## ./views/sale_order_views.xml
```xml
<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="view_order_form_extra_products" model="ir.ui.view">
        <field name="name">sale.order.form.extra.products</field>
        <field name="model">sale.order</field>
        <field name="inherit_id" ref="sale.view_order_form"/>
        <field name="arch" type="xml">

            <!-- Campos ocultos para lógica JS -->
            <xpath expr="//sheet" position="inside">
                <field name="has_extra_products" invisible="1"/>
                <field name="extra_products_dismissed" invisible="1"/>
            </xpath>

            <!-- Columna is_extra_product en las líneas (Odoo 19 usa list en lugar de tree) -->
            <xpath expr="//field[@name='order_line']/list" position="inside">
                <field name="is_extra_product" column_invisible="1"/>
            </xpath>

        </field>
    </record>

    <!-- Acción para ver líneas adicionales (stat button futuro) -->
    <record id="action_view_extra_products_lines" model="ir.actions.act_window">
        <field name="name">Productos Adicionales</field>
        <field name="res_model">sale.order.line</field>
        <field name="view_mode">list,form</field>
        <field name="domain">[('is_extra_product', '=', True)]</field>
    </record>
</odoo>```

