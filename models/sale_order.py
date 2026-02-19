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

    def get_extra_products_config(self):
        ICP = self.env['ir.config_parameter'].sudo()
        enabled = ICP.get_param('sale_extra_products_wizard.enabled', 'True') == 'True'
        trigger_confirm = ICP.get_param('sale_extra_products_wizard.trigger_confirm', 'True') == 'True'
        trigger_print = ICP.get_param('sale_extra_products_wizard.trigger_print', 'True') == 'True'

        category_ids_str = ICP.get_param('sale_extra_products_wizard.category_ids', '')
        category_ids = []
        if category_ids_str:
            try:
                import json
                parsed = json.loads(category_ids_str)
                # Odoo guarda many2many como [[6, false, [id1, id2, ...]]]
                if isinstance(parsed, list) and parsed:
                    inner = parsed[0]
                    if isinstance(inner, list) and len(inner) == 3:
                        category_ids = [int(i) for i in inner[2] if str(i).isdigit()]
                    elif isinstance(inner, int):
                        category_ids = [int(i) for i in parsed]
            except Exception:
                try:
                    category_ids = [int(x) for x in category_ids_str.split(',') if x.strip().isdigit()]
                except Exception:
                    category_ids = []

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
        ICP = self.env['ir.config_parameter'].sudo()
        category_ids_str = ICP.get_param('sale_extra_products_wizard.category_ids', '')
        category_ids = []
        if category_ids_str:
            try:
                import json
                parsed = json.loads(category_ids_str)
                if isinstance(parsed, list) and parsed:
                    inner = parsed[0]
                    if isinstance(inner, list) and len(inner) == 3:
                        category_ids = [int(i) for i in inner[2] if str(i).isdigit()]
                    elif isinstance(inner, int):
                        category_ids = [int(i) for i in parsed]
            except Exception:
                try:
                    category_ids = [int(x) for x in category_ids_str.split(',') if x.strip().isdigit()]
                except Exception:
                    category_ids = []

        if not category_ids:
            return []

        products = self.env['product.product'].search([
            ('categ_id', 'in', category_ids),
            ('sale_ok', '=', True),
            ('active', '=', True),
        ], order='categ_id, name')

        existing_product_ids = self.order_line.mapped('product_id').ids

        result = []
        for product in products:
            result.append({
                'id': product.id,
                'name': product.name,
                'display_name': product.display_name,
                'categ_name': product.categ_id.name,
                'categ_id': product.categ_id.id,
                'price': product.lst_price,
                'currency_symbol': self.currency_id.symbol or '$',
                'uom_name': product.uom_id.name,
                'image_url': f'/web/image/product.product/{product.id}/image_128',
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