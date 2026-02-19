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
        help='El vendedor descartó el pop-up de productos adicionales',
    )

    @api.depends('order_line', 'order_line.is_extra_product')
    def _compute_has_extra_products(self):
        for order in self:
            order.has_extra_products = any(
                line.is_extra_product for line in order.order_line
            )

    def get_extra_products_config(self):
        """Retorna configuración del módulo para el frontend."""
        ICP = self.env['ir.config_parameter'].sudo()
        enabled = ICP.get_param('sale_extra_products_wizard.enabled', 'True') == 'True'
        trigger_confirm = ICP.get_param('sale_extra_products_wizard.trigger_confirm', 'True') == 'True'
        trigger_print = ICP.get_param('sale_extra_products_wizard.trigger_print', 'True') == 'True'

        # Obtener IDs de categorías configuradas
        category_ids_str = ICP.get_param('sale_extra_products_wizard.category_ids', '')
        category_ids = []
        if category_ids_str:
            try:
                # El parámetro se guarda como "base.many2many..." - parseamos
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
        }

    def get_suggested_extra_products(self):
        """Retorna productos disponibles para el pop-up, filtrados por categorías configuradas."""
        ICP = self.env['ir.config_parameter'].sudo()
        category_ids_str = ICP.get_param('sale_extra_products_wizard.category_ids', '')
        category_ids = []
        if category_ids_str:
            try:
                category_ids = [int(x) for x in category_ids_str.split(',') if x.strip().isdigit()]
            except Exception:
                category_ids = []

        if not category_ids:
            return []

        # Productos de las categorías configuradas que estén activos y disponibles para venta
        products = self.env['product.product'].search([
            ('categ_id', 'in', category_ids),
            ('sale_ok', '=', True),
            ('active', '=', True),
        ], order='categ_id, name')

        # Obtener IDs de productos ya en la orden
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
        """Marca el pop-up como descartado."""
        self.write({'extra_products_dismissed': True})
        return True

    def action_add_extra_products(self, products_data):
        """
        Agrega productos adicionales a la orden.
        products_data: lista de dicts con {product_id, quantity, price_unit}
        """
        for item in products_data:
            product = self.env['product.product'].browse(item['product_id'])
            if not product.exists():
                continue

            # Verificar si ya existe una línea con ese producto como extra
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

        # Marcar como que ya tiene productos adicionales
        self.write({'extra_products_dismissed': True})
        return True
