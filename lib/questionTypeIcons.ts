/**
 * Shared icon data for question types — used by AppTree and QuestionTypePicker.
 * Raw icon data objects (not JSX) so consumers can render at any size.
 */
import ciText from '@iconify-icons/ci/text'
import tabler123 from '@iconify-icons/tabler/123'
import tablerDecimal from '@iconify-icons/tabler/decimal'
import ciCalendar from '@iconify-icons/ci/calendar'
import ciRadioFill from '@iconify-icons/ci/radio-fill'
import ciCheckboxCheck from '@iconify-icons/ci/checkbox-check'
import ciGroup from '@iconify-icons/ci/group'
import ciRepeat from '@iconify-icons/ci/repeat'
import ciHide from '@iconify-icons/ci/hide'
import ciLocation from '@iconify-icons/ci/location'
import ciImage from '@iconify-icons/ci/image'
import ciPhone from '@iconify-icons/ci/phone'
import ciBarcode from '@iconify-icons/ci/barcode'
import ciLabel from '@iconify-icons/ci/label'
import ciClock from '@iconify-icons/ci/clock'
import ciFileAdd from '@iconify-icons/ci/file-add'
import ciFileEdit from '@iconify-icons/ci/file-edit'
import ciFileBlank from '@iconify-icons/ci/file-blank'
import type { IconifyIcon } from '@iconify/react'

export const questionTypeIcons: Record<string, IconifyIcon> = {
  text: ciText,
  int: tabler123,
  decimal: tablerDecimal,
  date: ciCalendar,
  select1: ciRadioFill,
  select: ciCheckboxCheck,
  group: ciGroup,
  repeat: ciRepeat,
  hidden: ciHide,
  geopoint: ciLocation,
  image: ciImage,
  phone: ciPhone,
  barcode: ciBarcode,
  label: ciLabel,
  time: ciClock,
  datetime: ciClock,
}

export const questionTypeLabels: Record<string, string> = {
  text: 'Text',
  int: 'Number',
  decimal: 'Decimal',
  date: 'Date',
  select1: 'Single Select',
  select: 'Multi Select',
  group: 'Group',
  repeat: 'Repeat',
  geopoint: 'Location',
  image: 'Image',
  phone: 'Phone',
  barcode: 'Barcode',
  label: 'Label',
  time: 'Time',
  datetime: 'Date/Time',
  hidden: 'Hidden',
}

export const formTypeIcons: Record<string, IconifyIcon> = {
  registration: ciFileAdd,
  followup: ciFileEdit,
  survey: ciFileBlank,
}
