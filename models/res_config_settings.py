# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    extra_products_category_ids = fields.Many2many(
        'product.category',
        'config_extra_product_category_rel',
        'config_id',
        'category_id',
        string='Categorías de Productos Adicionales',
        help='Categorías de productos que se mostrarán en el pop-up de productos adicionales (ej: Adhesivos, Selladores)',
        config_parameter='sale_extra_products_wizard.category_ids',
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
