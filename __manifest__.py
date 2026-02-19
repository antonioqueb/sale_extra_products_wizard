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
