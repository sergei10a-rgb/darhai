/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Mongolian locale for the component library.
 *
 * Arco ships nineteen locales and Mongolian is not one of them, so every string
 * the components render themselves - the date picker's month names, "No data",
 * the pagination controls, the upload prompts, the OK/Cancel on every dialog -
 * came out in English inside an otherwise fully Mongolian app. Translating our
 * own screens was never enough on its own; roughly a third of the words on a
 * settings page belong to the library, not to us.
 *
 * Written against the shape of Arco's `en-US` locale, which is what the type
 * comes from. The parity test asserts this covers every key that one does, so a
 * library upgrade that adds a string cannot quietly reintroduce English.
 *
 * `Form` deliberately keeps the library's default validation messages: Arco's
 * own ru-RU, tr-TR and the rest do the same, because those strings come from
 * `b-validate` rather than the locale file, and half-translating them would be
 * worse than leaving one consistent source.
 */

import 'dayjs/locale/mn';
import enUS from '@arco-design/web-react/es/locale/en-US';

const Calendar = {
  // Mongolian writes the year first - "2026 оны 8-р сар", never "8-р сар 2026".
  formatYear: 'YYYY [он]',
  formatMonth: 'YYYY [оны] M[-р сар]',
  monthBeforeYear: false,
  monthFormat: 'M[-р сар]',
  yearFormat: 'YYYY [он]',
  today: 'Өнөөдөр',
  view: {
    month: 'Сар',
    year: 'Жил',
    week: 'Долоо хоног',
    day: 'Өдөр',
  },
  month: {
    long: {
      January: 'Нэгдүгээр сар',
      February: 'Хоёрдугаар сар',
      March: 'Гуравдугаар сар',
      April: 'Дөрөвдүгээр сар',
      May: 'Тавдугаар сар',
      June: 'Зургаадугаар сар',
      July: 'Долоодугаар сар',
      August: 'Наймдугаар сар',
      September: 'Есдүгээр сар',
      October: 'Аравдугаар сар',
      November: 'Арван нэгдүгээр сар',
      December: 'Арван хоёрдугаар сар',
    },
    // The numbered form is what Mongolians actually write in a compact slot.
    short: {
      January: '1-р сар',
      February: '2-р сар',
      March: '3-р сар',
      April: '4-р сар',
      May: '5-р сар',
      June: '6-р сар',
      July: '7-р сар',
      August: '8-р сар',
      September: '9-р сар',
      October: '10-р сар',
      November: '11-р сар',
      December: '12-р сар',
    },
  },
  week: {
    long: {
      self: 'Долоо хоног',
      monday: 'Даваа',
      tuesday: 'Мягмар',
      wednesday: 'Лхагва',
      thursday: 'Пүрэв',
      friday: 'Баасан',
      saturday: 'Бямба',
      sunday: 'Ням',
    },
    short: {
      self: '7 хоног',
      monday: 'Да',
      tuesday: 'Мя',
      wednesday: 'Лх',
      thursday: 'Пү',
      friday: 'Ба',
      saturday: 'Бя',
      sunday: 'Ня',
    },
  },
};

const mnMN: typeof enUS = {
  locale: 'mn-MN',
  dayjsLocale: 'mn',
  Calendar,
  DatePicker: {
    Calendar,
    placeholder: {
      date: 'Огноо сонгох',
      week: 'Долоо хоног сонгох',
      month: 'Сар сонгох',
      year: 'Жил сонгох',
      quarter: 'Улирал сонгох',
    },
    placeholders: {
      date: ['Эхлэх огноо', 'Дуусах огноо'],
      week: ['Эхлэх долоо хоног', 'Дуусах долоо хоног'],
      month: ['Эхлэх сар', 'Дуусах сар'],
      year: ['Эхлэх жил', 'Дуусах жил'],
      quarter: ['Эхлэх улирал', 'Дуусах улирал'],
    },
    selectTime: 'Цаг сонгох',
    selectDate: 'Огноо сонгох',
    today: 'Өнөөдөр',
    now: 'Одоо',
    ok: 'Болсон',
  },
  Drawer: {
    okText: 'Болсон',
    cancelText: 'Цуцлах',
  },
  Empty: {
    noData: 'Мэдээлэл алга',
  },
  Modal: {
    okText: 'Болсон',
    cancelText: 'Цуцлах',
  },
  Pagination: {
    goto: 'Очих',
    page: 'Хуудас',
    countPerPage: ' / хуудас',
    total: 'Нийт: {0}',
    prev: 'Өмнөх хуудас руу',
    next: 'Дараагийн хуудас руу',
    currentPage: '{0}-р хуудас',
    prevSomePages: 'Өмнөх {0} хуудас',
    nextSomePages: 'Дараагийн {0} хуудас',
    pageSize: 'хуудасны хэмжээ',
  },
  Popconfirm: {
    okText: 'Болсон',
    cancelText: 'Цуцлах',
  },
  Table: {
    okText: 'Болсон',
    resetText: 'Дахин тохируулах',
    sortAscend: 'Өсөхөөр эрэмбэлэхийн тулд дарна уу',
    sortDescend: 'Буурахаар эрэмбэлэхийн тулд дарна уу',
    cancelSort: 'Эрэмбэлэлтийг болиулахын тулд дарна уу',
  },
  TimePicker: {
    ok: 'Болсон',
    placeholder: 'Цаг сонгох',
    placeholders: ['Эхлэх цаг', 'Дуусах цаг'],
    now: 'Одоо',
  },
  Progress: {
    success: 'Дууссан',
    error: 'Бүтэлгүйтсэн',
  },
  Upload: {
    start: 'Эхлүүлэх',
    cancel: 'Цуцлах',
    delete: 'Устгах',
    reupload: 'Дахин оролдохын тулд дарна уу',
    upload: 'Байршуулах',
    preview: 'Урьдчилан харах',
    drag: 'Файлаа энд чирж авчрах эсвэл дарж сонгоно уу',
    dragHover: 'Байршуулахын тулд тавина уу',
    error: 'Байршуулахад алдаа гарлаа',
  },
  Typography: {
    copy: 'Хуулах',
    copied: 'Хуулсан',
    edit: 'Засах',
    fold: 'Хураах',
    unfold: 'Дэлгэх',
  },
  Transfer: {
    resetText: 'Дахин тохируулах',
  },
  ImagePreview: {
    fullScreen: 'Бүтэн дэлгэц',
    rotateRight: 'Баруун тийш эргүүлэх',
    rotateLeft: 'Зүүн тийш эргүүлэх',
    zoomIn: 'Томруулах',
    zoomOut: 'Жижигрүүлэх',
    originalSize: 'Жинхэнэ хэмжээ',
  },
  // Validation messages come from `b-validate`, not from the locale file. Arco's
  // own non-English locales leave them as-is for the same reason.
  Form: enUS.Form,
  ColorPicker: {
    history: 'Сүүлд хэрэглэсэн өнгө',
    preset: 'Бэлэн өнгө',
    empty: 'Хоосон',
    singleColor: 'Нэг өнгө',
    gradientColor: 'Шилжилтэт өнгө',
  },
};

export default mnMN;
