/** @odoo-module **/

import { Component, useState, onMounted } from "@odoo/owl";
import { registry } from "@web/core/registry";

/**
 * ExtraProductsDialog
 * Pop-up elegante para agregar productos adicionales a una SO.
 */
export class ExtraProductsDialog extends Component {
    static template = "sale_extra_products_wizard.ExtraProductsDialog";

    static props = {
        products: { type: Array },
        onConfirm: { type: Function },
        onSkip: { type: Function },
        onDismiss: { type: Function },
    };

    setup() {
        this.state = useState({
            activeCategory: null,
            // { [productId]: quantity }
            selected: {},
        });
    }

    // ------------------------------------------------------------------ //
    // Computed
    // ------------------------------------------------------------------ //

    get categories() {
        const map = {};
        for (const p of this.props.products) {
            if (!map[p.categ_id]) {
                map[p.categ_id] = { id: p.categ_id, name: p.categ_name, count: 0 };
            }
            map[p.categ_id].count++;
        }
        return Object.values(map);
    }

    get filteredProducts() {
        if (!this.state.activeCategory) return this.props.products;
        return this.props.products.filter(p => p.categ_id === this.state.activeCategory);
    }

    get selectedCount() {
        return Object.keys(this.state.selected).length;
    }

    get currencySymbol() {
        return this.props.products[0]?.currency_symbol || "$";
    }

    get totalAmount() {
        let total = 0;
        for (const [prodId, qty] of Object.entries(this.state.selected)) {
            const product = this.props.products.find(p => p.id === parseInt(prodId));
            if (product) total += product.price * qty;
        }
        return total;
    }

    // ------------------------------------------------------------------ //
    // Helpers
    // ------------------------------------------------------------------ //

    isSelected(productId) {
        return productId in this.state.selected;
    }

    getQty(productId) {
        return this.state.selected[productId] || 1;
    }

    formatPrice(amount) {
        return amount.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ------------------------------------------------------------------ //
    // Handlers
    // ------------------------------------------------------------------ //

    setCategory(categoryId) {
        this.state.activeCategory = categoryId;
    }

    toggleProduct(product) {
        if (this.isSelected(product.id)) {
            delete this.state.selected[product.id];
        } else {
            this.state.selected[product.id] = 1;
        }
    }

    changeQty(productId, delta) {
        if (!this.isSelected(productId)) return;
        const newQty = (this.state.selected[productId] || 1) + delta;
        if (newQty <= 0) {
            delete this.state.selected[productId];
        } else {
            this.state.selected[productId] = newQty;
        }
    }

    setQty(productId, value) {
        const qty = parseInt(value) || 1;
        if (qty <= 0) {
            delete this.state.selected[productId];
        } else {
            this.state.selected[productId] = qty;
        }
    }

    onOverlayClick() {
        // Click en el overlay no cierra (evitar cierres accidentales)
    }

    onImgError(ev) {
        // Reemplaza imagen rota con un emoji
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
    }

    onSkip() {
        this.props.onSkip();
    }

    onDismiss() {
        this.props.onDismiss();
    }
}
