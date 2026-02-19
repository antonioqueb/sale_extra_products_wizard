/** @odoo-module **/

import { Component, useState, onMounted, onWillUnmount } from "@odoo/owl";
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
            idleUnlocked: false,  // true después de 10s sin interacción
            idleCountdown: 10,
        });

        this._idleTimer = null;
        this._countdownInterval = null;
        this._lastActivity = Date.now();

        onMounted(() => {
            this._startIdleTimer();
            // Resetear el timer en cualquier interacción dentro del dialog
            this._boundActivity = () => this._onActivity();
            document.addEventListener("mousemove", this._boundActivity);
            document.addEventListener("keydown", this._boundActivity);
            document.addEventListener("click", this._boundActivity);
        });

        onWillUnmount(() => {
            this._clearTimers();
            document.removeEventListener("mousemove", this._boundActivity);
            document.removeEventListener("keydown", this._boundActivity);
            document.removeEventListener("click", this._boundActivity);
        });
    }

    _startIdleTimer() {
        this._clearTimers();
        this.state.idleCountdown = 10;
        this.state.idleUnlocked = false;

        // Countdown visual cada segundo
        this._countdownInterval = setInterval(() => {
            if (this.state.idleCountdown > 1) {
                this.state.idleCountdown--;
            } else {
                this._unlock();
            }
        }, 1000);

        // Unlock después de 10s
        this._idleTimer = setTimeout(() => {
            this._unlock();
        }, 10000);
    }

    _unlock() {
        this._clearTimers();
        this.state.idleUnlocked = true;
        this.state.idleCountdown = 0;
        LOG("⏱ Timeout — wizard desbloqueado para selección");
    }

    _onActivity() {
        // Solo resetear si aún no está desbloqueado
        if (!this.state.idleUnlocked) {
            this._lastActivity = Date.now();
            this._startIdleTimer();
        }
    }

    _clearTimers() {
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (this._countdownInterval) { clearInterval(this._countdownInterval); this._countdownInterval = null; }
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
        if (!this.state.idleUnlocked) return;  // Bloqueado hasta timeout o interacción
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
}

const LOG = (...args) => console.log("%c[ExtraWizard]", "color:#0f3460;font-weight:bold", ...args);