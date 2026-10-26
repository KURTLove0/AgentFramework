"""Compile a measurable job-specific rubric, frozen with each Agent execution."""
from copy import deepcopy

from .contracts import digest

VERSION = 'job-contract@1.0.0'
DIMENSIONS = {'identity': 10, 'responsibilities': 35, 'standards': 35, 'delivery': 20}


def duty_key(item):
    return 'duty-' + digest(item)[:16]


def normalize_config(value, definition, *, reconcile=False):
    from .definitions import STANDARDS
    duties = {duty_key(d): d for d in definition['responsibilities']}
    standards = set(definition['standard_refs'])
    default = {'threshold': None, 'weights': dict(DIMENSIONS),
               'responsibilities': {key: {'weight': 1, 'minimum_score': 100} for key in duties},
               'standards': {key: {'weight': 1, 'minimum_score': 100} for key in standards}}
    if value is None:
        return default
    if not isinstance(value, dict) or set(value) != set(default):
        raise ValueError('岗位评测配置字段不完整或含未知字段')
    if value['threshold'] is not None and (type(value['threshold']) is not int or not 1 <= value['threshold'] <= 100):
        raise ValueError('岗位评测阈值须为 1–100，或留空跟随空间规则')
    if not isinstance(value['weights'], dict) or set(value['weights']) != set(DIMENSIONS):
        raise ValueError('岗位评分维度无效')
    if any(type(w) is not int or not 1 <= w <= 97 for w in value['weights'].values()) or sum(value['weights'].values()) != 100:
        raise ValueError('四项维度分值须为正整数且合计 100')
    result = deepcopy(value)
    for kind, keys in (('responsibilities', set(duties)), ('standards', standards)):
        if not isinstance(value[kind], dict) or (not reconcile and set(value[kind]) != keys):
            raise ValueError('岗位评分项必须精确覆盖当前职责和标准')
        if kind == 'standards' and not keys <= STANDARDS.keys():
            raise ValueError('岗位引用了未登记标准')
        if reconcile:
            result[kind] = {k: value[kind].get(k, default[kind][k]) for k in keys}
        for rule in result[kind].values():
            if not isinstance(rule, dict) or set(rule) != {'weight', 'minimum_score'}:
                raise ValueError('每项评测需要权重和最低达成分数')
            if type(rule['weight']) is not int or not 1 <= rule['weight'] <= 100:
                raise ValueError('评测项权重须为 1–100')
            if type(rule['minimum_score']) is not int or not 1 <= rule['minimum_score'] <= 100:
                raise ValueError('评测项最低达成分数须为 1–100')
    return result


def compile_contract(definition, config=None, standards=None, *, processing_domain=None):
    from .definitions import STANDARDS
    config = normalize_config(config, definition)
    contract = {'version': VERSION, 'identity': deepcopy(definition['identity']),
                'domain_pack_ref': definition['domain_pack_ref'], 'capability_refs': list(definition['capability_refs']),
                'threshold': config['threshold'], 'weights': config['weights'],
                'responsibilities': [{'id': duty_key(d), **deepcopy(d), **config['responsibilities'][duty_key(d)]}
                                     for d in definition['responsibilities']],
                'standards': [{'ref': ref, 'check_refs': list(standards[ref]['verifier_refs'] if standards else STANDARDS[ref]),
                               **config['standards'][ref]} for ref in definition['standard_refs']]}
    if processing_domain:
        contract['processing_domain'] = deepcopy(processing_domain)
    return {**contract, 'hash': digest(contract)}
