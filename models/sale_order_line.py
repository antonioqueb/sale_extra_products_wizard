# -*- coding: utf-8 -*-
from odoo import fields, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    is_extra_product = fields.Boolean(
        string='Producto Adicional',
        default=False,
        help='Indica que esta línea fue agregada como producto adicional desde el pop-up',
    )
