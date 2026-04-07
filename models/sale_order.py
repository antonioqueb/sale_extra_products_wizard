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
        return True