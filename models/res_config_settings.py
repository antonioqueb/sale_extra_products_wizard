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
        )